var bcast = require('../lib/bcast');
var async = require('async');
var http = require('http');
var portscanner = require('portscanner');
var fs = require('fs');
var path = require('path');
var stream = require('stream');
var httpProxy = require('http-proxy');

exports.broadcast = require('nodeunit').testCase({
	setUp: function(cb) {
		var self = this;

		self.serverCount = 50;
		self.servers = [];

		for (var i = 0; i < self.serverCount; ++i) {
			self.servers.push(http.createServer(function(req, res) {
				
				// buffer chunks
				var chunks = [];
				req.on('data', function(chunk) { return chunks.push(chunk); });

				req.on('end', function() {
					var len = chunks
						.map(function(ch) { return ch.length; })
						.reduce(function(sum, size) { return sum + size; }, 0);

					res.writeHead(200, { 'x-body-length': len })
					res.end();
				});
			}));
		}

		// open post file for reading
		self.createAssetReadStream = function(name) {
			var p = path.join(__dirname, 'assets', name);
			var stream = fs.createReadStream(p);
			stream.size = fs.statSync(p).size;
			stream.pause();
			return stream;
		};

		// helper to allocate ports
		var start = 6000;
		self.nextPort = function(callback) {
			return portscanner.findAPortNotInUse(start++, 6999, 'localhost', callback);
		};

		return async.forEach(self.servers, function(server, cb) {
			self.nextPort(function(err, port) {
				if (err) return cb(err);
				server.listen(port);
				server.port = port;
				server.opened = true;
				return cb();
			});
		}, function() {

			// generate a request for each server
			var requests = self.requests = [], i = 0;
			self.servers.forEach(function(server) {
				return requests.push({
					name: 'req' + (i++),
					host: 'localhost',
					port: server.port,
					headers: { x: '1234 '},
					timeout: 5000,
				});
			});

			// generate a set of random indices which will be used
			// for the various failure tests
			var bad = self.bad = {};
			for (var i = 0; i < self.serverCount / 3; ++i) bad[Math.round(Math.random() * 100) % Object.keys(self.servers).length] = true;

			return cb();
		});
	},

	tearDown: function(cb) {
		var self = this;

		self.servers
			.forEach(function(s) { if (s.opened) s.close(); });

		return cb();
	},

	//
	// just send a GET request to all the servers
	// and expect 200 OK from all of them
	//

	allOkay: function(test) {
		var self = this;

		return bcast.broadcast(self.requests, function(err, results) {
			test.ok(!err, err);
			test.equals(Object.keys(results).length, Object.keys(self.servers).length);

			for (var k in results) {
				var result = results[k];
				test.equals(result.headers['x-body-length'], 0);
				test.equals(result.statusCode, 200);
			}

			test.done();
		});
	},

	// 
	// close 1/3 of the servers and verify that we have an error
	// reported from the closed servers.
	//

	someClosed: function(test) {
		var self = this;

		var closed = self.bad;
		for (var i in closed) {
			var key = Object.keys(self.servers)[i];
			var server = self.servers[key];
			server.close();
			server.opened = false;
		}

		// actual number in case there are dups
		var numberOfClosed = Object.keys(closed).length;

		// now send the broadcast
		return bcast.broadcast(self.requests, function(err, results) {
		    
			var numberOfErrors = 0;
			
			for (var k in results) {
				var result = results[k];
				if (result.err) numberOfErrors++;
				else test.equals(result.statusCode, 200);
			}

			// check number of errors
			test.equals(numberOfErrors, numberOfClosed);

			test.done();
		});
	},

	//
	// delay some of the results such that the broadcast timeout
	// will expire, thus returning an error
	//

	someDelayed: function(test) {
		var self = this;

		for (var s in self.bad) {
			var server = self.servers[s];
			server.removeAllListeners('request');
			server.on('request', function(req, res) {
				return setTimeout(function() { res.end(); }, 10000);
			});
		}

		return bcast.broadcast(self.requests, function(err, results) {
			
			var errors = Object.keys(results).map(function(k) {
				var result = results[k];
				return result.err ? 1 : 0;
			}).reduce(function(prev, curr) {
				return prev + curr;
			}, 0);

			test.equals(errors, Object.keys(self.bad).length);
			test.done();
		});
	},

	//
	// send a post request with some data
	//

	postFile: function(test) {
		var self = this;

		var stream = self.createAssetReadStream('post.dat');

		Object.keys(self.requests)
			.forEach(function(r) {
				var req = self.requests[r];
				req.method = 'post';
				req.body = stream;
			});
		
		return bcast.broadcast(self.requests, function(err, results) {
			for (var k in results) {
				var result = results[k];
				test.equals(result.statusCode, 200);
				test.equals(result.headers['x-body-length'], stream.size);
			}

			test.done();
		});
	},

	//
	// post data through an http server. this verifies that it is possible.
	//

	postRequest: function(test) {
		var self = this;

		var app = http.createServer(function(req, res) {

			// buffer data so that the async operation below (simulated by a timeout)
			// will not cause the loss of data.
			req.pause();
			var buffer = httpProxy.buffer(req);

			setTimeout(function() {

				Object.keys(self.requests)
					.forEach(function(i) {
						var r = self.requests[i];
						r.method = 'post';
						r.body = req;
					});

				bcast.broadcast(self.requests, function(err, results) {
					buffer.end();
					res.writeHead(200, { 'x-results': JSON.stringify(results) });
					return res.end();
				});

				// resume buffer and request
				buffer.resume();
				req.resume();

			}, 100);

		});

		var stream = self.createAssetReadStream('nodejs.html');

		return self.nextPort(function(err, port) {
			test.ok(!err, err);

			app.listen(port, function(err) {

				var r = http.request({
					method: 'post',
					hostname: 'localhost',
					port: port,
				});

				r.on('response', function(res) {

					// parse results from header and verify body length is correct
					var results = JSON.parse(res.headers['x-results']);
					for (var k in results) {
						var result = results[k];
						test.equals(result.statusCode, 200);
						test.equals(result.headers['x-body-length'], stream.size);
					}

					app.close();
					test.done();
				});

				stream.pipe(r);
				stream.resume();
			});
		});
	},
});
