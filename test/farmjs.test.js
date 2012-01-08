var fs = require('fs');
var path = require('path');

var async = require('async');

var farmjs = require('../main');
var instman = require('./instman');
var logule = require('logule');

var defaultExpectations = require('./cases').$default;
console.log(defaultExpectations);

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

	var cases = require('./cases').tests;
	async.forEach(cases, function(c, next) {
		//self.log("CASE: " + JSON.stringify(c));

		//
		// Send request to all instances and verify they all behave as expected
		//

		self.instman.reqall(c.from, function(err, allresults) {
			self.ok(test, c, !err);

			if (!c.expected) throw new Error("Invalid test case, 'expected' is required");

			function assertExpected(res, expected, inst) {
				//self.log(c.from, '==>', expected);

				if (expected.status) {
					self.equals(test, c, res.statusCode, expected.status);
				}

				// this means that we can use the echo response to check a few more things
				if (expected.status === 200) {
					var echo = JSON.parse(res.body);

					self.equals(test, c, res.headers['content-type'], "application/json");

					// check some 'must-exist' headers
					self.ok(test, c, echo.headers[farmjs.HEADER_REQID], "Expecting x-farmjs-reqid header");
					self.equals(test, c, echo.headers[farmjs.HEADER_URL], c.from, "Expecting x-farmjs-url header");

					if (expected.headers) {
						for (var h in expected.headers) {
							self.equals(test, c, echo.headers[h], expected.headers[h]);
						}
					}

					var expectedURL = expected.url || "/";
					if (expectedURL) {
						self.equals(test, c, echo.url, expectedURL, "Expecting URL passed to app should be " + expectedURL);
					}

					if (expected.app) {
						self.equals(test, c, echo.headers[farmjs.HEADER_APP], expected.app, "Expecting app to be " + expected.app);
						self.equals(test, c, echo.appbasename, expected.app, "Expecting app to be " + expected.app);
					}

					if (expected.spawn) {
						var expectedScript = path.normalize(expected.spawn.replace('$', path.join(__dirname, 'workdir')));
						self.equals(test, c, echo.argv[1], expectedScript, "Expecting script to be " + expectedScript);
					}

					if (expected.instance) {
						self.equals(test, c, echo.inst, expected.instance, "Expecting response from instance " + expected.instance);
					}
					else {
						self.equals(test, c, echo.inst, inst, "Expecting instance to be the one we sent the request to");
					}

					if (expected.proxy) {
						self.ok(test, c, echo.webserver, "Expecting response to come from webserver");
					}
				}
				else {
					if (expected.redirect) {
						self.equals(test, c, res.headers.location, expected.redirect, "Expecting redirect location to be " + expected.redirect);
					}

					if (expected.body) {
						self.equals(test, c, res.headers['content-type'], "application/json", "Body is expected, so we need json");

						var body = JSON.parse(res.body);
						for (var k in expected.body) {
							self.equals(test, c, body[k], expected.body[k], "Expecting body to contain " + k + ": " + expected.body[k]);
						}
					}
				}
			}

			for (var inst in allresults) {
				var results = allresults[inst];
				for (var endpoint in results) {
					var expected = {};
					var globalDefaults = defaultExpectations[endpoint];
					for (var k in globalDefaults) expected[k] = globalDefaults[k];

					var caseDefaults = c.expected.$default;
					if (caseDefaults) {
						for (var k in caseDefaults) expected[k] = caseDefaults[k];
					}

					var exp = c.expected[endpoint];
					for (var k in exp) expected[k] = exp[k];

					assertExpected(results[endpoint], expected, inst);
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