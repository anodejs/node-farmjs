var testCase = require('nodeunit').testCase;
var farmjs = require('../main');
var express = require('express');
var request = require('request');
var logule = require('logule');
var http = require('http');

logule = logule.suppress('info');
logule = logule.suppress('trace');

var appresolver = require('./lib/appresolver');

exports.simple = testCase({
    setUp: function(cb) {
        try{
            var self = this;
            self.server = express.createServer();
            var options = {
                instance: 'one',
                authPrivate: false,
                getAppByName: appresolver(8090),
                getInstances: function(cb) { return cb(null, {}); },
                logger: logule,
            };
            self.router = farmjs.createRouter(options);
            self.server.use(self.router.connect());
            self.server.port = 8080;
            self.server.listen(self.server.port);
            self.req = function(method, url, callback) { 
                var o = {
                    method: method,
                    url: 'http://localhost:' + self.server.port + url,
                };
                return request(o, callback); 
            };
            return cb();
        }catch(e){console.error(e);}
    },

    tearDown: function(cb) {
        var self = this;
        self.server.close();
        self.router.close();
        return cb();
    },

    crossDomain: function(test) {
        var self = this;
        return self.req('OPTIONS', '/test', function(err, res, body) {
            test.equals(res.headers['access-control-allow-credentials'], 'true');
            test.equals(res.headers['access-control-allow-origin'], '*');
            test.equals(res.headers['access-control-allow-methods'], 'GET,PUT,POST,DELETE,OPTIONS');

            var allowedHeaders = {};
            res.headers['access-control-allow-headers'].split(', ').forEach(function(h) {
                allowedHeaders[h] = true;
            });

            // make sure all farmjs headers are allowed
            for (var k in farmjs.HEADERS) {
                var expected = farmjs.HEADERS[k];
                test.ok(expected in allowedHeaders, "expecting '" + farmjs.HEADERS[k] + "' to be in the access-control-allow-headers header");
            }

            test.done();
        });
    },

    manualSpin: function(test) {
        var self = this;
        self.router.spin('test', function(err, port) {
            test.ok(!err, err);
            test.ok(port);

            // port is a named pipe/unix-domain-sockets.
            var req = http.request({ socketPath: port }, function(res) {
                var body = '';
                res.on('data', function(data) { body += data.toString(); });
                res.on('end', function() {
                    body = JSON.parse(body);
                    test.ok(~body.argv[1].replace(/\\/g, '/').indexOf('workdir/master/apps/test'), "expecting the app to be test");
                    test.equals(body.appname, 'test');
                    var pid1 = body.pid;
                    return self.req('GET', '/test', function(err, res, body) {
                        body = JSON.parse(body);
                        test.equals(pid1, body.pid, "Expecting requests to go to the same process");
                        test.done();
                    });
                })
            });

            req.end();
        });
    },
    
});