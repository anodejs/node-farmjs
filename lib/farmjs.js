var uuid = require('node-uuid');
var urlparser = require('url');
var util = require('util');
var express = require('express');
var spinner = require('spinner');
var httpProxy = require('http-proxy');

var ctxcon = require('ctxobj').console;
var Resolver = require('./resolver').Resolver;

//
// Some constants
//

exports.HEADER_URL   = 'x-farmjs-url';
exports.HEADER_REQID = 'x-farmjs-reqid';
exports.HEADER_APP   = 'x-farmjs-app';

/**
 * Creates a farm.js middleware
 */
function Farmjs(opts) {
	var self = this;
	if (!opts) opts = {};
	if (!opts.logger) opts.logger = console;
	if (!opts.portRange) opts.portRange = [ 7000, 7999 ];
	if (!opts.idleTime) opts.idleTime = 15;
	if (!opts.authPrivate) opts.authPrivate = true;
	if (!opts.getAppByName) opts.getAppByName = function(logger, name, callback) { callback(new Error('still no apps')); };

	//
	// Make logger contextual and push timestamp to context
	//

	self.logger = ctxcon(opts.logger);

	self.resolver = new Resolver();

	//
	// Create `spinner` which is used to spawn processes and allocate ports
	//

	self.spinner = spinner.createSpinner();

	//
	// Create http-proxy
	//

	self.proxy = new httpProxy.RoutingProxy();

	//
	// getAppByName is used to look up for apps
	//

	self.getAppByName = opts.getAppByName;

	//
	// authPrivate means that private apps must be authenticated with a client cert
	//

	self.authPrivate = opts.authPrivate;

	return self;
};


/**
 * Create a connect with farm.js installed. This can be used to plug-in farm.js
 * into another connect server like this:
 *
 *    app.use(farmjs.connect());
 *
 */
Farmjs.prototype.connect = function() {
	var self = this;

	var connect = require('connect');
	var app = connect.createServer();

	for (var name in self._handlers) {
		handler = self._handlers[name];
		var fn = self._createMiddleware(name, handler);
		app.use(fn);
	}
	
	return app;
};

Farmjs.prototype.close = function(callback) {
	var self = this;
	self.logger.info("Closing farm");
	self.spinner.stopall(callback);
	return self;
};

/**
 * Adds a *.domain to the list of parent domains
 */
Farmjs.prototype.addParentDomain = function(domain) {
	var self = this;
	self.resolver.addRootDomain(domain);
	return self;
}

Farmjs.prototype._handlers = {

	/**
	 * Creates request context
	 */
	context: function(req, res, next) {
		var self = this;

		req.times = {};
		req.times.start = new Date();

    	req.reqid = req.headers[exports.HEADER_REQID] = uuid().replace(/-/g, '');
		req.logger = self.logger.pushctx(req.reqid);


		var origend = res.end;
		res.end = function() {
			req.times.end = new Date();

			var latency = req.times.end.valueOf() - req.times.start.valueOf();
			req.logger.info("Latency: " + latency + "ms");

			req.logger.info("Ending request with status: " + res.statusCode);
			origend.apply(res, arguments);
		};

		res.error = function(status, obj) {
			if (!obj) obj = {};
			if (util.isError(obj)) {
				if (!self.debug) obj = { msg: obj.toString() };
				else obj = { msg: obj.toString(), stack: obj.stack };
			}
			if (typeof obj === "string") obj = { msg: obj };
			req.logger.warn(status + " " + JSON.stringify(obj));
			obj.status = status || 500;
			res.writeHead(obj.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(obj));
			return self;
		};

		/**
		 * Ends a request by proxying it to some other host
		 * @param port Target port (required).
		 * @param host Target host (optional, default is 'localhost')
		 */
		var buffer = httpProxy.buffer(req);
		res.proxy = function(port, host) {
			if (!host) host = 'localhost';
			if (!port) throw new Error('port is required');
			
			req.logger.info("Proxy request to " + host + ":" + port);

			return self.proxy.proxyRequest(req, res, {
				host: host,
				port: port,
				buffer: buffer,
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
		req.logger.info(req.method, req.purl.href);
		if (Object.keys(req.hints) > 0) req.logger.info('hints', req.hints);
		next();
	},

	/**
	 * Find app associated with request. If an app is an alias to another app, use it instead.
	 */
	app: function(req, res, next) { 
		this._lookupAppHandler(req.purl.app, req, res, next); 
	},
	
	alias: function(req, res, next) {
		if (!req.app.alias) return next();
		this._lookupAppHandler(req.app.alias.target, req, res, next);
	},

	/**
	 * Authenticate private apps, if required.
	 */
	authPrivate: function(req, res, next) {
		var self = this;

		//
		// If this farm does not require private apps to be authenticated, continue
		//

		if (!self.authPrivate) return next();

		//
		// If this app is marked as 'public', continue
		//

		if (req.app.public) return next();

		//
		// App is private, check if an authorized client cert has been presented
		//

		req.logger.info("App requires client certificate authentication because it is not marked as 'public'");
        var requestIsAuthenticated = req.client && req.client.pair && req.client.pair.cleartext && req.client.pair.cleartext.authorized;
        if (!requestIsAuthenticated) return res.error(401, "Forbidden: '" + req.app.name + "' requires an authenticated client");

        //
        // Continue
        //

        return next();
	},

	/**
	 * $inst: Proxy request to a different farm instance
	 */
	inst: function(req, res, next) {
		if (!('$inst' in req.hints)) return next();
		req.logger.info('$inst=', req.url.hints.$inst);
		return res.proxy({ host: 'localhost', port: 1234 });
	},

	/**
	 * $bcast: Proxy request to all instances and collect results synchronsouly
	 */
	bcast: function(req, res, next) {
		if (!('$bcast' in req.hints)) return next();
		return res.end('bcast is here');
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

		req.logger.info('Spinning ' + req.app.spawn.command + ' ' + req.app.spawn.script);
		req.app.spawn.logger = req.logger;
		self.spinner.start(req.app.spawn, function(err, port) {
			if (err) return res.error(500, new Error("unable to spawn app " + req.app.name + ". " + err.toString()));

			//
			// Proxy the request to the spawned process
			//

			req.logger.info("Script spawned and accessible via", port);
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

		req.logger.info("Proxy request to " + req.app.proxy.host + ":" + req.app.proxy.port + " with headers " + JSON.stringify(req.app.proxy.headers));

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
Farmjs.prototype._createMiddleware = function(handlerName, handlerFn) {
	var self = this;
	self.logger.info("Installing middleware '" + handlerName + "'");
	return function(req, res, next) {
		var pushed = false;
		if (req.logger) {
			pushed = true;
			req.logger = req.logger.pushctx('@' + handlerName);
		}
		handlerFn.call(self, req, res, function() {
			if (pushed) req.logger = req.logger.popctx();
			next();
		});
	}
}

Farmjs.prototype._lookupAppHandler = function(name, req, res, next) {
	var self = this;
	self.getAppByName(req.logger, name, function(err, app) {
		if (err || !app) return res.error(404, err || "app '" + name + "' not found");

		// overload app info on request and create x-farmjs-app header.						
		req.app = app;
		req.headers[exports.HEADER_APP] = req.app.basename;

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
Farmjs.prototype._parseURL = function(req, secure) {
	var self = this;

	//
	// Construct full URL from request
	// 

	var protocol = !secure ? 'http:' : 'https:';
	var origurl = req.url;
	var url = protocol + '//' + req.headers.host + req.url;

	req.logger.info("URL to parse: " + url);

	//
	// Override incoming URL (x-farmjs-url)
	//

	var urloverride = req.headers[exports.HEADER_URL];
	if (urloverride) {
		req.logger.info("URL overridden by " + exports.HEADER_URL + " to " + urloverride);
		url = urloverride;
	}

	//
	// Convert URL to object
	//

	url = urlparser.parse(url, true);
    url.original = origurl;

	//
	// Extract $ hints from query
	//

    var hints = {};
    for (var key in url.query) {
        if (key[0] === '$') {
            hints[key] = url.query[key];
            
            if (hints[key] !== "") req.logger.info('hint "' + key + '" = ' + hints[key]);
            else req.logger.info('hint "' + key + '" provided');
        	
            delete url.query[key];
        }
    }

    url.hints = hints;

	//
	// Resolve app from URL, or override by $app hint
	//

	if (hints.$app && hints.$app !== '' && hints.$app !== null) {
		req.logger.info("App defined by $app");
		url.app = hints.$app;
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

    req.logger.info('ORIGINAL:', url.original);
    req.logger.info('APP     :', url.app);
    req.logger.info('HREF    :', url.href);

    return url;
};

/**
 * Creates a farm.js Express plugin
 */
exports.create = function(opts) {
	return new Farmjs(opts);
};