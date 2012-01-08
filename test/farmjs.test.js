var fs = require('fs');
var path = require('path');

var async = require('async');

var farmjs = require('../main');
var instman = require('./instman');
var logule = require('logule');

logule.suppress('trace');

var tests = { };
tests.setUp = function(cb) {
	var self = this;
	
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

	self.instman = instman.createInstanceManager({ logger: logule });
	
	self.req = function(url, callback) {
		return self.instman.req('inst0', url, callback);
	};

	self.ok = function(test, c, condition, msg) {
		var m = c.from;
		if (msg) m += ": " + msg;
		return test.ok(condition, m);
	};

	self.equals = function(test, c, obj1, obj2, msg) {
		var m = c.from;
		if (msg) m += ": " + msg;
		return test.deepEqual(obj1, obj2, m);
	}

	self.log('SETUP');
	return self.instman.startMany(5, cb);
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
	self.instman.close();
	cb();
};

tests.all = function(test) {
	var self = this;

	//
	// Iterate through all the cases and run them (in parallel !)
	//

	var cases = require('./cases').apps;
	async.forEach(cases, function(c, next) {
		self.log("CASE: " + JSON.stringify(c));

		//
		// Send request to all instances and verify they all behave as expected
		//

		self.instman.reqall(c.from, function(err, allresults) {
			self.ok(test, c, !err);

			for (var id in allresults) {
				var results = allresults[id];

				//
				// If the request does not target a public app, we expect 401 from both 'http' and 'https' endpoints
				//

				if (!c.public && c.error !== 404) {
					self.equals(test, c, results.http.statusCode, 401);
					self.equals(test, c, results.https.statusCode, 401);
					delete results.http;
					delete results.https;
				}

				for (var k in results) {
					var res = results[k];
					var body = res.body;

					var expectedStatus = c.error ? c.error : 200;
					self.equals(test, c, res.statusCode, expectedStatus, c.from);
					self.equals(test, c, res.headers['content-type'], "application/json");

					if (res.statusCode === 200) {
						body = JSON.parse(body);

						self.equals(test, c, body.url, c.path, "Expecting URL passed to app should be " + c.path);
						
						if (c.spawn) {
							var expectedScript = path.normalize(c.spawn.replace('$', path.join(__dirname, 'workdir')));
							self.equals(test, c, body.argv[1], expectedScript, "Expecting script to be " + expectedScript);
						}

						self.equals(test, c, body.headers[farmjs.HEADER_URL], c.from, "Expecting x-farmjs-url header");
						self.equals(test, c, body.headers[farmjs.HEADER_APP], c.app, "Expecting app to be " + c.app);
						self.ok(test, c, body.headers[farmjs.HEADER_REQID], "Expecting x-farmjs-reqid header");
						self.equals(test, c, body.appbasename, c.app, "Expecting app to be " + c.app);
						if (c.instance) self.equals(test, c, body.inst, c.instance, "Expecting response from instance " + c.instance);
						if (c.proxy) self.ok(test, c, body.webserver, "Expecting response to come from webserver");
					}
					else if (res.statusCode !== expectedStatus) {
						self.log(body);
					}			
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