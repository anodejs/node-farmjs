var fs = require('fs');
var path = require('path');

var async = require('async');

var farmjs = require('../main');
var instman = require('./instman');
var logule = require('logule');

var defaultExpectations = require('./cases').$default;

//
// some test definitions
//

var ITER = async.forEach;
var NO_OF_INSTANCES = 3;
var METHODS = [ 'POST', 'GET' ];
var SHOW_TRACE = false;

//
// set up code
//

if (!SHOW_TRACE) logule.suppress('trace');
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
	};


	self.log('SETUP');
	return self.instman.startMany(NO_OF_INSTANCES, cb);
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
	ITER(cases, function(c, next) {

		//
		// Send request to all instances and verify they all behave as expected
		//

		self.instman.reqall(c.from, METHODS, function(err, allresults) {
			self.ok(test, c, !err);

			if (!c.expected) throw new Error("Invalid test case, 'expected' is required");

			function assertExpected(res, expected, inst) {

				self.ok(test, c, !res.err, "not expecting an error:" + res.err);

				//self.log(c.from, '==>', expected);

				if (expected.status) {
					self.equals(test, c, res.statusCode, expected.status);
				}

				// this means that we can use the echo response to check a few more things
				if (expected.status === 200) {

					self.equals(test, c, res.headers['content-type'], "application/json");

					var echo;
					if (!expected.bcast) {
						return _assertEcho(JSON.parse(res.body));
					}
					else {

						// handle broadcast responses. these responses basically contain
						// the status code and headers for all the instances. the actual echo
						// is in the x-echo header, so we extract it from there and call _assertEcho
						// to verify it against the expecations.

						var broadcastResponses = JSON.parse(res.body);

						for (var id in broadcastResponses) {
							var response = broadcastResponses[id];
							var echo = JSON.parse(response.headers['x-echo']);
							expected.instance = id; // make sure the instance fits the instance in the response
							_assertEcho(echo);
						}
					}

					function _assertEcho(echo) {

						// request id must exist
						self.ok(test, c, echo.headers[farmjs.HEADER_REQID], "Expecting x-farmjs-reqid header");

						if (expected.headers) {
							for (var h in expected.headers) {
								self.equals(test, c, echo.headers[h], expected.headers[h]);
							}
						}

						if (expected.url) {
							self.equals(test, c, echo.url, expected.url, "Expecting URL passed to app should be " + expected.url);
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

						if (expected.method === "POST") {
							self.equals(test, c, echo.bodyLength, self.instman.postBodyLength, "Since this is a POST, expecting body length");
						}
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

			//
			// iterate over results from all instances
			//

			for (var inst in self.instman.instances) {

				var results = allresults[inst];

				self.ok(test, c, results, "expecting results");

				//
				// iterate over results from all endpoints
				//

				for (var method in results) {

					var endpoints = results[method];

					self.ok(test, c, endpoints, "expecting endpoints in the results for " + method);

					//
					// iterate over all http methods

					for (var endpoint in endpoints) {

						var result = endpoints[endpoint];

						self.ok(test, c, result, "expecting result for method " + method + " endpoint " + endpoint);

						//
						// prepare the 'expected' object by overriding global 
						// and then local defaults
						//

						var expected = {};

						// global defaults
						var globalDefaults = defaultExpectations[endpoint];
						for (var k in globalDefaults) expected[k] = globalDefaults[k];

						// local default
						var caseDefaults = c.expected.$default;
						if (caseDefaults) for (var k in caseDefaults) expected[k] = caseDefaults[k];

						// actual case

						var exp = c.expected[endpoint];

						for (var k in exp) expected[k] = exp[k];

						//
						// put some matrix-specific data on the expected object
						//

						expected.method = method;

						//
						// check that the result fits expectation
						//

						assertExpected(result, expected, inst);
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