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

exports.HEADER_URL          = 'x-farmjs-url';
exports.HEADER_REQID        = 'x-farmjs-reqid';
exports.HEADER_APP          = 'x-farmjs-app';
exports.HEADER_APP_FULLNAME = 'x-farmjs-app-fullname';

/**
 * Creates a farm.js middleware
 */
function Router(opts) {
    var self = this;
    opts = opts || {};
    
    if (!opts.instance) throw new Error("instance is required");

    opts.logger = ctxcon(opts.logger || console);
    opts.resolver = opts.resolver || new Resolver();
    if (!opts.getAppByName) throw new Error('getAppByName not defined');
    if (!opts.getInstances) throw new Error("getInstances not defined");
    if (!('authPrivate' in opts)) opts.authPrivate = true;

    opts.range = opts.range || [ 7000, 7999 ];

    var spinnerOptions = {
        range: opts.range,
        stdout: process.stdout,
        stderr: process.stderr,
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
    // getAppByName is used to look up for apps
    //

    self.getAppByName = opts.getAppByName;
    delete opts.getAppByName;

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
}

Router.prototype._handlers = {

    /**
     * Creates request context
     */
    context: function(req, res, next) {
        var self = this;

        req.secure = req.connection.pair ? true : false;

        req.times = {};
        req.times.start = new Date();

        // if there is already a reqid in the header, reuse it
        // otherwise, generate one.
        req.reqid = req.headers[exports.HEADER_REQID];
        if (!req.reqid) {
            req.reqid = req.headers[exports.HEADER_REQID] = uuid().replace(/-/g, '');
        }

        var logger = req.options.logger || self.logger;
        req.logger = logger.pushctx(req.reqid);

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
            logline += " " + req.app.name;
            logline += " " + req.url;
            if (res.statusCode === 302) logline += " REDIRECT " + res.getHeader('location');
            logline += " " + latency + "ms";
            if (res.errorObject) logline += " " + JSON.stringify(res.errorObject);
            fn.call(req.logger, logline);

            //req.buffer.resume();
            //req.buffer.end();
            //req.on('data', function(data) { process.stderr.write(data); });

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

        next();
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
        if (!req.app.alias) return next();
        self._lookupAppHandler(req.app.alias.target, req, res, next);
    },

    /**
     * Redirect apps marked as { secure: true } to their https:// counterpart
     */
    httpsRedirect: function(req, res, next) {
        if (req.secure) return next(); // we are in 'https', nothing to do

        // if https-only is required by the app, redirect to the https counterpart
        // of the same url.
        if (req.app.secure) {
            var location = 'https://' + req.headers.host + req.purl.original;
            req.logger.log('secure app accessed via HTTP. redirecting to HTTPS: ', req.app.name, location);
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

        if (req.app.public) return next();

        //
        // App is private, check if an authorized client cert has been presented
        //

        //TODO: Maybe we should use request.connection.verifyPeer() here?
        req.logger.log("App requires client certificate authentication because it is not marked as 'public'");
        var requestIsAuthenticated = req.client && req.client.pair && req.client.pair.cleartext && req.client.pair.cleartext.authorized;
        if (!requestIsAuthenticated) return res.error(401, "Forbidden: '" + req.app.name + "' requires an authenticated client");
        req.logger.log("Client certificate found");

        //
        // Continue
        //

        return next();
    },

    blocked: function(req, res, next) {
        if (!req.app.blocked) return next();
        return res.error(403, req.app.blocked);
    },

    /**
     * $inst: Proxy request to a different farm instance
     */
    inst: function(req, res, next) {
        var self = this;
        var inst = req.hints.$inst;

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

    /**
     * Redirect request to app dashboard
     */
    dash: function(req, res, next) {
        if (!('$dash' in req.hints || '$log' in req.hints)) return next();
        return res.end('redirect to dashboard');
    },

    /**
     * Spawn - if app.spawn is defined, we will spawn the script defined in it, allocating a port and
     * then proxy the request to this newly spawnned process.
     */
    spawn: function(req, res, next) {
        var self = this;

        if (!req.app.spawn) return next();

        //
        // Spin it up, dambo!
        //

        req.logger.log('Spinning', req.app.spawn.command, req.app.spawn.args);
        
        // create spinner options by cloning req.app.spawn
        var options = { };
        for (var k in req.app.spawn) options[k] = req.app.spawn[k];
        options.logger = req.logger;

        // add some env variables
        options.env = options.env || {};
        options.env.FARMJS_APP = req.app.basename;
        options.env.FARMJS_APP_FULLNAME = req.app.name;
        options.env.FARMJS_INSTANCE = req.options.instance;

        self.spinner.start(options, function(err, port) {
            if (err) return res.error(500, new Error("unable to spawn app " + req.app.name + ". " + err.toString()));

            //
            // Proxy the request to the spawned process
            //

            req.logger.log("Script spawned and accessible via", port);
            return res.proxy(port);
        }, req.logger);
    },

    /**
     * Proxy - app.proxy is defined, we will just proxy the request to `host`:`port` with `headers`.
     */
    proxy: function(req, res, next) {
        var self = this;

        if (!req.app.proxy) return next();

        if (!req.app.proxy.host) req.app.proxy.host = "localhost";
        if (!req.app.proxy.port) return res.error(500, "Cannot proxy app without a port");
        if (!req.app.proxy.headers) req.app.proxy.headers = {};

        //
        // Add headers
        //

        var headers = req.app.proxy.headers;
        for (var h in headers) req.headers[h] = headers[h];

        //
        // Proxy
        //

        return res.proxy(req.app.proxy.port, req.app.proxy.host);
    },

    catchall: function(req, res, next) {
        res.error(404, "Not found");
    },

    /**
     * Handle all errors, the connect way
     */
    errors: express.errorHandler({ showStack: true, dumpExceptions: true }),
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
 */
Router.prototype._lookupAppHandler = function(name, req, res, next) {
    var self = this;
    self.getAppByName(req.logger, name, function(err, app) {
        if (err || !app) return res.error(404, err || "app '" + name + "' not found");

        // overload app info on request and create x-farmjs-app header.                     
        req.app = app;
        req.headers[exports.HEADER_APP] = req.app.basename;
        req.headers[exports.HEADER_APP_FULLNAME] = req.app.name;

        next();
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

    var urloverride = req.headers[exports.HEADER_URL];
    if (urloverride) {
        req.logger.log("URL overridden by " + exports.HEADER_URL + " to " + urloverride);
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
    else if (req.headers[exports.HEADER_APP]) {
        req.logger.log('app defined by ' + exports.HEADER_APP);
        url.app = req.headers[exports.HEADER_APP];
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
            headers[exports.HEADER_APP] = req.app.name; // override app via header (because we can't use hostname for that)
            delete headers[exports.HEADER_URL]; // do not repeat URL override

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
}

/**
 * Creates a farm.js router Express middleware
 */
exports.createRouter = function(opts) {
    return new Router(opts);
};
