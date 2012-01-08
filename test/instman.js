var async = require('async');
var portscanner = require('portscanner');
var urlparser = require('url');
var ctxconsole = require('ctxobj').console;
var logule = require('logule');
var http = require('http');
var https = require('https');
var express = require('express');
var farmjs = require('../main');
var appresolver = require('./appresolver');
var fs = require('fs');
var path = require('path');

function InstanceManager(options) {
	var self = this;
	options = options || {};
	options.logger = options.logger || logule;

	self.instances = {};
	self.logger = ctxconsole(options.logger);
	return self;
}

//
// shuts down all instances
//
InstanceManager.prototype.close = function() {
	var self = this;

	for (var id in self.instances) {
		self.logger.info('Closing instance', id);
		var inst = self.instances[id];
		inst.router.close();
		inst.http.server.close();
		inst.https.server.close();
		inst.web.server.close();
		inst.internal.server.close();
	}
};

// 
// Sends a request to all farm instances.
//
InstanceManager.prototype.reqall = function(url, callback) {
	var self = this;
	var results = {};
	return async.forEachSeries(Object.keys(self.instances), function(id, cb) {
		self.req(id, url, function(err, res) {
			if (err) return cb(err);
			results[id] = res;
			return cb();
		});
	}, function(err) {
		if (err) return callback(err);
		return callback(null, results);
	});
};

//
// Sends three requests to a farm.js instance: http, https and https+cc
//
// @param id Instance ID
// @param url The request URL
// @param callback
//
InstanceManager.prototype.req = function(id, url, callback) {
	var self = this;
	var inst = self.instances[id];

	if (!inst) new Error('unknown instance ' + id);
	if (!url) new Error('url is required');
	if (!callback) callback = function() { };

	// parse url
	var parsed = urlparser.parse(url);

	//
	// For every URL, we are issuing three requests:
	//  (1) Plain old HTTP (expect to fail for non-public apps)
	//  (2) HTTPS without a client cert (expect to fail for non-public apps)
	//  (3) HTTPS with a client cert (expect to succeed on all)
	//

	function _request(protocol, port, cert) {
		return function(cb) {

			var options = {
				host: 'localhost',
				port: port,
				path: parsed.path,
				method: 'GET',
				headers: {},
				agent: false,
			};

			if (cert) {
				options.key = _readAssetSync('cc_private.pem');
				options.cert = _readAssetSync('cc_public.pem');
			}

			options.headers[farmjs.HEADER_URL] = url;

			var req = protocol.request(options, function(res) {
				var body = '';
				res.on('data', function(data) {
					body += data.toString();
				});
				res.on('end', function(){
					res.body = body;
					cb(null, res);
				});
			});

			req.on('error', function(e) {
				cb(e);
			});

			req.end();			
		}
	}

	return async.parallel(
	[
		_request(http, inst.http.port, false),
		_request(https, inst.https.port, false),
		_request(https, inst.https.port, true),
	], 
	function(err, results) {

		var result = {
			'http': results[0],
			'https': results[1],
			'authHttps': results[2]
		};

		callback(null, result);
	});
};

//
// starts 'count' farm instances
//
InstanceManager.prototype.startMany = function(count, callback) {
	var self = this;
	var range = [];
	for (var i = 0; i < count; ++i) range.push(i);

	function _createInstance(i, cb) {
		return self.start(i, function(err, inst) {
			if (err) return cb(err);
			return cb();
		});
	}

	var instances = {};
	async.forEachSeries(range, _createInstance, function(err) {
		if (err) return callback(err);
		return callback(null, instances);
	});
};

//
// creates a farmjs instance which contains the following endpoints
//  1. http: a farmjs http:// router
//  2. https: a farmjs https:// router that requests client certs for private apps
//  3. internal: a farmjs http:// router without requirement for a client cert for private apps
//  4. web: a simple http web server for 'proxy' type requests
//
// calls `callback` with a hash with port numbers for each of those endpoints.
// uses `portscanner` to find available ports.
//
InstanceManager.prototype.start = function(index, callback) {
	var self = this;
	if (!callback) callback = function() { };

	var id = 'inst' + index;

	if (self.instances[id]) throw new Error("instance " + id + " already started");

	var range = [ 4000, 4999 ];

	function _findport(callback) {
		return portscanner.findAPortNotInUse(range[0], range[1], 'localhost', callback);
	}

	var router = null;

	function _startWebServer(callback) {
		return _findport(function(err, port) {
			if (err) return callback(err);

			// create an http server for proxying non-spawned requests
			var webServer = http.createServer(function(req, res) {

				var echo = {
					webserver: true,
					appbasename: req.headers[farmjs.HEADER_APP],
					appname: req.headers[farmjs.HEADER_APP_FULLNAME],
					inst: id,
					port: process.env.PORT,
					argv: process.argv,
					url: req.url,
					headers: req.headers,
				};

				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(echo, true, 2));

			}).listen(port);


			var spinnerRangeStart = 7000 + 100 * index;
			var spinnerRangeEnd = spinnerRangeStart + 100 - 1;
			var spinnerRange = [ spinnerRangeStart, spinnerRangeEnd ];

			var routerOptions = {
 				logger: self.logger.pushctx(id), 
 				instance: id,
 				range: spinnerRange,
			};

			router = farmjs.createRouter(routerOptions);
			router.addParentDomain("anodejs.org");
			router.getAppByName = appresolver(port, id);

			router.getInstanceByID = function(id, callback) {
				var inst = self.instances[id];
				if (!inst) return callback(new Error("instance "+ id + " not found"));
				return callback(null, { host: 'localhost', port: inst.internal.port });
			}

			return callback(null, { server: webServer, port: port });
		});
	}

	function _startHttpRouter(callback) {
		return _findport(function(err, port) {
			if (err) return callback(err);

			var http = express.createServer();
			http.listen(port);
			http.use(router.connect({ logger: self.logger.pushctx(id + ":http    ") }));
			return callback(null, { server: http, port: port });
		});
	}

	function _startHttpsRouter(callback) {
		return _findport(function(err, port) {
			if (err) return callback(err);

			var https = express.createServer({
		        key: _readAssetSync('private.pem'),
		        cert: _readAssetSync('public.pem'),
		        ca: [ _readAssetSync('cc_public.pem') ],
				requestCert: true,
		        rejectUnauthorized: false,
			});

			https.listen(port);
			https.use(router.connect({ logger: self.logger.pushctx(id + ":https   ") }));

			return callback(null, { server: https, port: port });
		});
	}

	function _startInternalRouter(callback) {
		return _findport(function(err, port) {
			if (err) return callback(err);

			var http = express.createServer();
			http.listen(port);
			http.use(router.connect({ authPrivate: false, logger: self.logger.pushctx(id + ":internal") }));
			return callback(null, { server: http, port: port });
		});
	}

	return async.series([ 
		_startWebServer, 
		_startHttpRouter, 
		_startHttpsRouter,
		_startInternalRouter,
	], 
	function(err, results) {
		if (err) return callback(err);
		self.instances[id] = {
			router: router,
			web: results[0],
			http: results[1],
			https: results[2],
			internal: results[3],
		};
		return callback(null, self.instances[id]);
	});
};

exports.createInstanceManager = function() {
	return new InstanceManager();
};

// -- helpers

function _readAssetSync(name) {
	return fs.readFileSync(path.join(__dirname, 'assets', name));
}