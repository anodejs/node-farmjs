var fs = require('fs');
var path = require('path');
var urlparser = require('url');
var http = require('http');
var https = require('https');

var express = require('express');
var request = require('request');
var async = require('async');
var logule = require('logule');

var farmjs = require('../main');

var tests = { };

tests.setUp = function(cb) {

	var self = this;
	self.servers = [];
	
	var port = self.port = 5080;
	var securePort = self.securePort = 5443;
	var webserverPort = self.webserverPort = 8000;
	var workdir = self.workdir = path.join(__dirname, 'workdir');

	/**
	 * Helper log function so it will be easy to differeciate test logs from other stuff
	 */
	self.log = function() {
		var args = [];
		args.push('\n================================================================================================================\n')
		for (var k in arguments) args.push(arguments[k]);
		args.push('\n================================================================================================================\n')
		console.info.apply(console, args);
	}

	/**
	 * Helper request method. Uses the x-farmjs-url header to override
	 * URL when sending a request to localhost.
	 */
	self.req = function(url, callback) {

		var parsed = urlparser.parse(url);

		//
		// For every URL, we are issuing three requests:
		//  (1) Plain old HTTP (expect to fail for non-public apps)
		//  (2) HTTPS without a client cert (expect to fail for non-public apps)
		//  (3) HTTPS with a client cert (expect to succeed on all)
		//

		function request(protocol, port, cert) {
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
				  options.key = self.readAssetSync('cc_private.pem');
				  options.cert = self.readAssetSync('cc_public.pem');
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

		async.parallel(
		[
			request(http, port, false),
			request(https, securePort, false),
			request(https, securePort, true),
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

	/**
	 * Returns a path to a test asset
	 */
	self.asset = function(fileName) {
		return path.join(__dirname, 'assets', fileName); 
	};

	/**
	 * Returns the contents of a test asset
	 */
	self.readAssetSync = function(fileName) {
		return fs.readFileSync(self.asset(fileName));
	};

	//
	// Create farm object
	//

	self.farmjs = farmjs.create({
		logger: logule
	});

	self.farmjs.addParentDomain("anodejs.org");
	self.farmjs.getAppByName = function(logger, name, callback) {
		logger.info('getappbyname called with', name);

		if (!(name in self.apps)) {
			callback(new Error("app '" + name + "' not found"));
			return;
		}

		callback(null, self.apps[name]);
	}

	//
	// Create an HTTP server for proxying non-spawned requests (simluates a web server)
	//

	var webServer = http.createServer(function(req, res) {
		var echo = {
			webserver: true,
			port: process.env.PORT,
			argv: process.argv,
			url: req.url,
			headers: req.headers,
		};

		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(echo, true, 2));
	}).listen(webserverPort);

	self.servers.push(webServer);

	var appsData = fs.readFileSync(path.join(workdir, 'apps.json'));
	self.apps = JSON.parse(appsData);

	// add path to index file, damn it
	for (var appname in self.apps) {
		var app = self.apps[appname];

		if (app.type === "node") {
			var script = path.join(self.workdir, app.index);
			app.spawn = {
				name: app.name,
				command: process.execPath,
				args: [ script ],
				monitor: script,
			};

			// this will be the contents of the index file.
			var indexTemplate = function() {
				var http = require('http');

				http.createServer(function(req, res) {

					var echo = {
						port: process.env.PORT,
						argv: process.argv,
						url: req.url,
						headers: req.headers,
					};

					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(echo, true, 2));
					
				}).listen(process.env.PORT);
				
				console.log('app started on port', process.env.PORT);
			};

			var indexContents = "(" + indexTemplate.toString() + ")();";
			fs.writeFileSync(script, indexContents);
		}
		else {

			app.proxy = {
				host: 'localhost',
				port: self.webserverPort,
				headers: {
					'x-nospawn': 'yes',
					'x-anodejs-rewrite': app.index
				}
			};

		}
	}

	var jsonFile = path.join(__dirname, "apps." + Math.round(Math.random() * 10000) + ".json");
	fs.writeFileSync(jsonFile, JSON.stringify(self.apps, true, 2));
	self.log("Apps stored under:", jsonFile);


	cb();
};

var inner = tests.setUp;
tests.setUp = function(cb) {
	try { inner.call(this, cb); }
	catch (e) {
		console.log(e.stack);
		cb(e);
	}
};

tests.tearDown = function(cb) {
	var self = this;
	self.log('TEARDOWN');
	self.farmjs.close();
	self.servers.forEach(function(app) { app.close(); });
	cb();
};

tests.t1 = function(test) {
	var self = this;

	//
	// Start http server and connect farmjs to it
	// 

	var http = express.createServer();
	http.listen(self.port);
	http.use(self.farmjs.connect());
	self.servers.push(http);

	//
	// Start https server with client cert
	//

	var https = express.createServer({
        key: self.readAssetSync('private.pem'),
        cert: self.readAssetSync('public.pem'),
        ca: [ self.readAssetSync('cc_public.pem') ],
		requestCert: true,
        rejectUnauthorized: false,
	});

	https.listen(self.securePort);
	https.use(self.farmjs.connect());
	self.servers.push(https);

	//
	// Iterate through all the cases and run them in series (could be in parallel as well...)
	//

	var cases = require('./cases').apps;
	async.forEachSeries(cases, function(c, next) {
		self.log("CASE: " + JSON.stringify(c));

		//
		// Send request

		self.req(c.from, function(err, results) {
			test.ok(!err, err);

			//
			// If the request does not target a public app, we expect 401 from both 'http' and 'https' endpoints
			//

			if (!c.public && c.error !== 404) {
				test.equals(results.http.statusCode, 401);
				test.equals(results.https.statusCode, 401);

				delete results.http;
				delete results.https;
			}

			for (var k in results) {
				var res = results[k];
				var body = res.body;

				var expectedStatus = c.error ? c.error : 200;
				test.equals(res.statusCode, expectedStatus, c.from);
				test.equals(res.headers['content-type'], "application/json");

				if (res.statusCode === 200) {
					body = JSON.parse(body);

					test.equals(body.url, c.path, "Expecting URL passed to app should be " + c.path);
					
					if (c.spawn) {
						var expectedScript = path.normalize(c.spawn.replace('$', self.workdir));
						test.equals(body.argv[1], expectedScript, "Expecting script to be " + expectedScript);
					}

					test.equals(body.headers[farmjs.HEADER_URL], c.from, "Expecting x-farmjs-url header");
					test.equals(body.headers[farmjs.HEADER_APP], c.app, "Expecting app to be " + c.app);
					test.ok(body.headers[farmjs.HEADER_REQID], "Expecting x-farmjs-reqid header");
				}
				else {
					self.log(body);
				}			
			}

			next();
		});
	},
	
	function(err) {
		test.ok(!err, err);
		test.done();
	});
};

exports.tests = require('nodeunit').testCase(tests);