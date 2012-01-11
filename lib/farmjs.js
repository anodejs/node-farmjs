var uuid = require('node-uuid');
var async = require('async');
var urlparser = require('url');
var util = require('util');
var express = require('express');
var spinner = require('spinner');
var httpProxy = require('http-proxy');
var http = require('http');
var bcast = require('./bcast');

var ctxcon = require('ctxobj').console;
var Resolver = require('./resolver').Resolver;

//
// Some constants
//

exports.HEADERS = {
    URL: 'x-farmjs-url',
    REQID: 'x-farmjs-reqid',
    APP: 'x-farmjs-app',
    INSTANCE: 'x-farmjs-instance',
};

/**
 * Creates a farm.js middleware
 */
function Router(opts) {
    var self = this;
    opts = opts || {};
    
    if (!opts.instance) throw new Error("instance is required");

    opts.logger = ctxcon(opts.logger || console);
    opts.resolver = opts.resolver || new Resolver();
    if (!opts.decide) throw new Error('"decide" function is not defined');
    if (!opts.getInstances) throw new Error("getInstances not defined");
    if (!('authPrivate' in opts)) opts.authPrivate = true;

    opts.range = opts.range || [ 7000, 7999 ];

    var spinnerOptions = {
        range: opts.range,
//        stdout: process.stdout,
//        stderr: process.stderr,
        timeout: 30 
    };

    opts.spinner = opts.spinner || spinner.createSpinner(spinnerOptions);

    process.stderr.setMaxListeners(1000);
    process.stdout.setMaxListeners(1000);

    //
    // This is the logger used for the non-middleware code
    // (we keep the one in options for the middleware function)
    //

    self.logger = ctxcon(opts.logger);

    //
    // Resolves app name from URLs
    //

    self.resolver = opts.resolver;
    delete opts.resolver;

    //
    // Create `spinner` which is used to spawn processes and allocate ports
    //

    self.spinner = opts.spinner;
    delete opts.spinner;

    //
    // Create http-proxy
    //

    self.proxy = new httpProxy.RoutingProxy();

    //
    // decide is used to decide how to handle a request
    //

    self.decide = opts.decide;
    delete opts.decide;

    //
    // getInstances is used to look up instances
    //

    self.getInstances = opts.getInstances;
    delete opts.getInstances;

    //
    // 'options' will be available on middleware `req` objects as well
    // and may be overriden by the connect() function
    //

    self.options = opts;

    //
    // Install default action handlers
    //

    self._actionHandlers = {};
    self.install('error', self._errorAction);
    self.install('spawn', self._spawnAction);
    self.install('proxy', self._proxyAction);
    self.install('redirect', self._redirectAction);
    self.install('alias', self._aliasAction);

    return self;
};


/**
 * Create a connect with farm.js installed. This can be used to plug-in farm.js
 * into another connect server like this:
 *
 *    app.use(farmjs.connect());
 *
 */
Router.prototype.connect = function(optionsOverride) {
    var self = this;
    optionsOverride = optionsOverride || {};

    var connect = require('connect');
    var app = connect.createServer();

    var options = {};
    for (var k in self.options) options[k] = self.options[k];
    for (var k in optionsOverride) options[k] = optionsOverride[k];

    for (var name in self._handlers) {
        handler = self._handlers[name];
        var fn = self._createMiddleware(name, handler, options);
        app.use(fn);
    }
    
    return app;
};

/**
 * Installs an action handler.
 * Action handles are invoked based on the result of a `decide` call. The `{action:{...}}`
 * structure within the result may contain a single key, which is the action type.
 * `actionHandler` is `function(action, req, res, next)` and may use the extended API of `req` and `res`
 * to handle the request. `next` is provided to allow forfitting the action, but this will usually not work.
 * Only a single handler may be installed per action type.
 */
Router.prototype.install = function(actionType, actionHandler) {
    var self = this;

    if (actionType in self._actionHandlers) throw new Error("there is already a handler for action type " + actionType);

    self._actionHandlers[actionType] = actionHandler;

    return true;
};

/**
 * Shuts down any spawned child processes
 */
Router.prototype.close = function(callback) {
    var self = this;
    self.logger.info("Closing farm");
    self.spinner.stopall(callback);
    return self;
};

/**
 * Adds a *.domain to the list of parent domains
 */
Router.prototype.addParentDomain = function(domain) {
    var self = this;
    self.resolver.addRootDomain(domain);
    return self;
};

/**
 * This is the request pipeline
 */
Router.prototype._handlers = {

    /**
     * First things first -- generate a request ID, in case it is not already 
     * provided in the request header.
     */
    reqid: function(req, res, next) {

        // if there is already a reqid in the header, reuse it
        // otherwise, generate one.
        req.reqid = req.headers[exports.HEADERS.REQID];
        if (!req.reqid) {
            req.reqid = req.headers[exports.HEADERS.REQID] = uuid().replace(/-/g, '');
        }

        // put request id header on response as well.
        res.header(exports.HEADERS.REQID, req.reqid);
        res.header(exports.HEADERS.INSTANCE, req.options.instance);

        // push request id to logger context
        var logger = req.options.logger || self.logger;
        req.logger = logger.pushctx(req.reqid);

        return next();
    },

    /**
     * Add stuff to `req` object so it can be used along the pipe.
     */
    context: function(req, res, next) {
        var self = this;

        req.secure = req.connection.pair ? true : false;

        req.times = {};
        req.times.start = new Date();

        var origend = res.end;
        res.end = function() {
            req.times.end = new Date();

            var latency = req.times.end.valueOf() - req.times.start.valueOf();

            var fn = req.logger.info;
            if (res.statusCode >= 0 && res.statusCode < 400) fn = req.logger.info;
            else if (res.statusCode >= 400 && res.statusCode < 500) fn = req.logger.warn;
            else fn = req.logger.error;

            var logline = "HTTP";
            logline += " " + res.statusCode;
            logline += " " + req.method;
            logline += " " + req.purl.app;
            logline += " " + req.url;
            if (res.statusCode === 302) logline += " REDIRECT " + res.getHeader('location');
            logline += " " + latency + "ms";
            if (res.errorObject) logline += " " + JSON.stringify(res.errorObject);
            fn.call(req.logger, logline);

            origend.apply(res, arguments);
        };

        res.error = function(status, obj) {
            if (!obj) obj = {};
            if (util.isError(obj)) {
                if (!self.debug) obj = { msg: obj.toString() };
                else obj = { msg: obj.toString(), stack: obj.stack };
            }
            if (typeof obj === "string") obj = { msg: obj };
            obj.status = status || 500;
            res.errorObject = obj;
            res.writeHead(obj.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
            return self;
        };

        /**
         * Ends a request by proxying it to some other host
         * @param port Target port (required).
         * @param host Target host (optional, default is 'localhost')
         */
        req.buffer = httpProxy.buffer(req);
        res.proxy = function(port, host) {
            if (!host) host = 'localhost';
            if (!port) throw new Error('port is required');
            
            req.logger.log("Proxy request to " + host + ":" + port, req.url);

            self.proxy.proxyRequest(req, res, {
                host: host,
                port: port,
                buffer: req.buffer,
            });
        };

        return next();
    },

    /**
     * Emit Access-Control-Allow-* headers to allow cross domain calls
     * to apps in the farm.
     * Reference: [CORS](http://www.w3.org/TR/cors/)
     */
    allowCrossDomain: function(req, res, next) {
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');

        var allowedHeaders = Object.keys(exports.HEADERS).map(function(h) { return exports.HEADERS[h]; });
        allowedHeaders.push('content-type');

        res.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));

        return next();
    },

    /**
     * Parse URL
     * Extracts 'purl' (with .app), 'hints'.
     * Adds a 'x-farmjs-app' header to the request.
     */
    parseurl: function(req, res, next) {
        var self = this;
        req.purl = self._parseURL(req);
        req.url = req.purl.path; // update url on request
        req.hints = req.purl.hints; // make hints more accessible

        // add the 'x-farmjs-app' header
        if (req.purl.app) req.headers[exports.HEADERS.APP] = req.purl.app;

        next();
    },

    /**
     * Log request details
     */
    log: function(req, res, next) {
        var self = this;
        req.logger.log('Incoming', req.method, req.purl.href);
        if (Object.keys(req.hints) > 0) req.logger.log('hints', req.hints);
        next();
    },

    /**
     * Find app associated with request. If an app is an alias to another app, use it instead.
     */
    app: function(req, res, next) { 
        var self = this;
        self._lookupAppHandler(req.purl.app, req, res, next); 
    },
    
    alias: function(req, res, next) {
        var self = this;
        if (!req.decision.action.alias) return next();
        self._lookupAppHandler(req.decision.action.alias.target, req, res, next);
    },

    /**
     * Redirect apps marked as { secure: true } to their https:// counterpart
     */
    secure: function(req, res, next) {
        if (req.secure) return next(); // we are in 'https', nothing to do

        // if https-only is required by the app, redirect to the https counterpart
        // of the same url.
        if (req.decision.secure) {
            var location = 'https://' + req.headers.host + req.purl.original;
            req.logger.log('secure app accessed via HTTP. redirecting to HTTPS: ', req.purl.app, location);
            return res.redirect(location);
        }

        return next();
    },

    /**
     * Authenticate private apps, if required.
     */
    authPrivate: function(req, res, next) {
        var self = this;

        //
        // If this farm does not require private apps to be authenticated, continue
        //

        if (!req.options.authPrivate) return next();

        //
        // If this app is marked as 'public', continue
        //

        if (req.decision.public) return next();

        //
        // App is private, check if an authorized client cert has been presented
        //

        //TODO: Maybe we should use request.connection.verifyPeer() here?
        req.logger.log("App requires client certificate authentication because it is not marked as 'public'");
        var requestIsAuthenticated = req.client && req.client.pair && req.client.pair.cleartext && req.client.pair.cleartext.authorized;
        if (!requestIsAuthenticated) return res.error(401, "Forbidden: '" + req.purl.app + "' requires an authenticated client");
        req.logger.log("Client certificate found");

        //
        // Continue
        //

        return next();
	},

    /**
     * $inst/x-farmjs-instance: Proxy request to a different farm instance
     */
    inst: function(req, res, next) {
        var self = this;

        // instance can be specified either using the $inst query hint
        // or x-farmjs-instance header in the request ($inst has precedence).
        var inst = req.hints.$inst || req.headers[exports.HEADERS.INSTANCE];

        if (!inst) return next();
        if ('$bcast' in req.hints) return error(400, "$inst and $bcast are not allowed together");

        if (inst === req.options.instance) {
            req.logger.log('$inst specified, but this is the same instnace');
            return next();
        }

        // now proxy away
        return self._proxyToInstance(req, res, inst);
    },

    /**
     * $bcast: Proxy request to all instances and collect results synchronsouly
     */
    bcast: function(req, res, next) {

        var self = this;
        
        if (!('$bcast' in req.hints)) return next();
        if ('$inst' in req.hints) return error(400, "$inst and $bcast are not allowed together");

        //
        // prepare requets for broadcast
        //

        return self._prepareRequestsForBroadcast(req, function(err, requests) {
        
            //
            // send broadcast (without waiting for results, but input is piped)
            //
            
            req.logger.log('broadcasting request to ' + requests.length + ' instances');
            bcast.broadcast(requests, function(err, results) {
                if (err) return res.error(500, "broadcast failed:" + err.toString());

                //
                // response contains the aggregated results
                //

                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify(results));
            });

            //
            // resume the proxy buffer so that request events
            // are emitted (otherwise, data will not be piped into the broadcast).
            //

            req.buffer.resume();
            req.resume();
        });

    },

    //
    // This stage basically performs the action based on the only key in `decision.action`.
    // Actions are middleware arrays installed using router.install(actionHandler).
    // Handlers are `function(req, res, next)`
    //
    performAction: function(req, res, next) {
        var self = this;
        var type = Object.keys(req.decision.action)[0];
        var handler = self._actionHandlers[type];
        if (!handler) return error(500, "Unable to find handler for action type " + type);
        return handler.call(self, req.decision.action[type], req, res, next);
    },

    //
    // This middleware basically returns 404 on anything not handled so far
    //
    catchall: function(req, res, next) {
        return res.error(404, "Not found");
    },
};

/**
 * Creates a middleware function to be used on a farm.js app
 */
Router.prototype._createMiddleware = function(handlerName, handlerFn, options) {
    var self = this;

    self.logger.log("Installing middleware '" + handlerName + "' with options " + JSON.stringify(options));

    return function(req, res, next) {
        
        // copy options from 'self' to req, then override.
        req.options = options;

        // put a contextual logger on the request
        var pushed = false;
        if (req.logger) {
            pushed = true;
            req.logger = req.logger.pushctx('@' + handlerName);
        }

        // call the middleware
        handlerFn.call(self, req, res, function() {
            if (pushed) req.logger = req.logger.popctx();
            next();
        });
    };
};

/**
 * Handle for app lookup
 * Decision structure:
 *
 *       var decision = {
 *           secure: false,  // 'true' will redirect HTTP connections to their HTTPS counterparts (default: false)
 *           public: false,  // 'false' will allow accessing the app only via the HTTPS endpoint with a client cert (default: false)
 *
 *           // action may contain only one of the below options
 *           action: { 
 *               spawn: {
 *                   command: {string}
 *                   args: [ {string} ]
 *               },
 *               proxy: {
 *                  host: {string} (optional, default 'localhost')
 *                   port: {number}
 *                   headers: {hash} (optional)
 *               },
 *               redirect: {
 *                   location: {url}
 *               }
 *               alias: {
 *                   app: {string}
 *               },
 *               block: {
 *                   [message: {string}]
 *               },
 *               error: {
 *                   status: {number}
 *                   [headers: {hash}]
 *                   [message: {string}]
 *               }
 *           }
 *       }
 *
 */
Router.prototype._lookupAppHandler = function(name, req, res, next) {
    var self = this;
    
    return self.decide(req, name, function(err, decision) {
        if (err || !decision) return res.error(404, err || "app '" + name + "' not found");

        //
        // verify that the decision is well-formed.
        //

        req.logger.log('Decision:', JSON.stringify(decision));

        //
        // verify that we only have a single action
        //

        if (Object.keys(decision.action).length !== 1) {
            return res.error(500, "decision for app " + name + " needs to contain exactly one verb");
        }

        //
        // verify that the action is one of the allowed actions
        //



        var verb = Object.keys(decision.action)[0];
        if (!(verb in self._actionHandlers)) {
            return res.error(500, "action '" + verb + "' not one of: " + JSON.stringify(Object.keys(self._actionHandlers)));
        }

        //
        // store decision on request bus
        //

        req.decision = decision;

        return next();
    });
};

/**
 * Parses the incoming URL and returns a URL object.
 * Besides the regular URL properties, it also contains:
 *  - `hints` hash - '$' hints and values provided in the URL (all are removed from the query)
 *  - `app` - the name of the farm.js app as returned by the resovler (if the app uses path addressing
 *            'pathname' and 'path' will be fixed to not include it.
 */
Router.prototype._parseURL = function(req, secure) {
    var self = this;

    //
    // Construct full URL from request
    // 

    var protocol = !secure ? 'http:' : 'https:';
    var origurl = req.url;
    var url = protocol + '//' + req.headers.host + req.url;

    req.logger.log("URL to parse: " + url);

    //
    // Override incoming URL (x-farmjs-url)
    //

    var urloverride = req.headers[exports.HEADERS.URL];
    if (urloverride) {
        req.logger.log("URL overridden by " + exports.HEADERS.URL + " to " + urloverride);
        url = urloverride;
    }

    //
    // Convert URL to object
    //

    url = urlparser.parse(url, true);
    url.original = origurl;
    req.headers.host = url.host;

    //
    // Extract $ hints from query
    //

    var hints = {};
    for (var key in url.query) {
        if (key[0] === '$') {
            hints[key] = url.query[key];
            
            if (hints[key] !== "") req.logger.log('hint "' + key + '" = ' + hints[key]);
            else req.logger.log('hint "' + key + '" provided');
            
            delete url.query[key];
        }
    }

    url.hints = hints;

    //
    // Resolve app from URL, or override by $app hint
    //

    if (hints.$app && hints.$app !== '' && hints.$app !== null) {
        req.logger.log("app defined by $app");
        url.app = hints.$app;
    }
    else if (req.headers[exports.HEADERS.APP]) {
        req.logger.log('app defined by ' + exports.HEADERS.APP);
        url.app = req.headers[exports.HEADERS.APP];
    }
    else {
        var resolved = self.resolver.resolve(url.hostname, url.pathname);
        url.pathname = resolved.pathname;
        url.app = resolved.app;
    }

    //
    // Recreate URL and copy relevant fields to get rid of $ query parameters
    //

    var x = urlparser.parse(urlparser.format({
        protocol: url.protocol,
        slashes: url.slashes,
        host: url.host,
        pathname: url.pathname,
        query: url.query,
    }), true);

    for (var k in x) url[k] = x[k];

    req.logger.log('ORIGINAL:', url.original);
    req.logger.log('APP     :', url.app);
    req.logger.log('HREF    :', url.href);

    return url;
};

/**
 * Proxy a request to a specific instance
 */
Router.prototype._proxyToInstance = function(req, res, inst) {
    var self = this;

    // look up instance by name
    return self.getInstances(function(err, instances) {
        if (err) res.error(500, err);

        // look up instance by id
        var address = instances[inst];
        if (!address) return res.error(400, new Error("unable to find instance with id " + inst));

        // revert the original url, so the target router will be able
        // to identify the app
        req.url = req.purl.original;

        // proxy the request to the target instance
        return res.proxy(address.port, address.host);
    });
};

/**
 * Prepares request objects for `bcast.broadcast`
 */
Router.prototype._prepareRequestsForBroadcast = function(req, callback) {
    var self = this;

    // remove limit of max listeners on req
    req.setMaxListeners(0);

    return self.getInstances(function(err, instances) {
        var requests = Object.keys(instances).map(function(id) {
            var address = instances[id];

            // prepare headers
            var headers = {};
            for (var k in req.headers) headers[k] = req.headers[k];

            headers[exports.HEADERS.APP] = req.purl.app; // override app via header (because we can't use hostname for that)
            delete headers[exports.HEADERS.URL]; // do not repeat URL override

            return {
                name: id,
                hostname: address.host,
                port: address.port,
                path: req.url,
                method: req.method,
                headers: headers,
                body: req,
            };
        });

        callback(null, requests);
    });
};

/**
 * Error Action
 * Allows responding with arbitrary http status codes.
 */
Router.prototype._errorAction = function(params, req, res, next) {
    var self = this;

    //
    // Copy headers, if provided
    //
    if (params.headers) for (var k in params.headers) res.headers[k] = params.headers[k];

    //
    // Respond with an error
    //

    return res.error(params.status, params);
};

/**
 * Spawn Action
 * If this action is defined, we will spawn the script defined in it, allocating a port and
 * then proxy the request to this newly spawnned process.
 */
Router.prototype._spawnAction = function(params, req, res, next) {
    var self = this;

    //
    // Spin it up, dambo!
    //

    req.logger.log('Spinning', params.command, params.args);
    
    // create spinner options by cloning params as-is
    var options = { };
    for (var k in params) options[k] = params[k];
    
    // set name
    options.name = req.purl.app;

    // set logger
    options.logger = req.logger;

    // add some env variables
    options.env = options.env || {};
    options.env.FARMJS_APP = req.purl.app;
    options.env.FARMJS_INSTANCE = req.options.instance;

    return self.spinner.start(options, function(err, port) {
        if (err) return res.error(500, new Error("unable to spawn app " + req.purl.app + ". " + err.toString()));

        //
        // Proxy the request to the spawned process
        //

        req.logger.log("Script spawned and accessible via", port);
        return res.proxy(port);
    }, req.logger);
};

/**
 * Proxy Action
 * This allows to proxy the request to `host`:`port` with `headers`.
 */
Router.prototype._proxyAction = function(params, req, res, next) {
    var self = this;

    if (!params.port) return res.error(500, "Cannot proxy app without a port");

    var host = params.host || "localhost";
    var port = params.port;
    var headers = params.headers || {};

    //
    // Add headers
    //

    for (var h in headers) req.headers[h] = headers[h];

    //
    // Proxy
    //

    return res.proxy(port, host);
};

/**
 * Redirect Action
 */
Router.prototype._redirectAction = function(params, req, res, next) {
    if (!params.location) return error(500, "redirect action must contain a 'location' parameter");
    return res.redirect(params.location);
};

/**
 * Alias Action
 * In fact, 'alias' is resolved before authentication, so this handler is fake, to keep validation code happy.
 * At a later stage we can model "pre-authentication" and "post-authentication" actions so it will be first-class.
 */
Router.prototype._aliasAction = function(params, req, res, next) {
    return res.error(500, "alias should have been resolved at an earlier stage");
};

// ------ Module API

/**
 * Creates a farm.js router Express middleware
 */
exports.createRouter = function(opts) {
    return new Router(opts);
};
