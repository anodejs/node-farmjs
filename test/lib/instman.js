var async = require('async');
var portscanner = require('portscanner');
var urlparser = require('url');
var ctxconsole = require('ctxobj').console;
var logule = require('logule');
var http = require('http');
var https = require('https');
var express = require('express');
var farmjs = require('../../main');
var appresolver = require('./appresolver');
var fs = require('fs');
var path = require('path');
var request = require('request');

function InstanceManager(options) {
    var self = this;
    options = options || {};
    options.logger = options.logger || logule;

    self.instances = {};
    self.logger = ctxconsole(options.logger);

    self.postBody = fs.readFileSync(_assetPath('small.html'));
    self.postBodyLength = self.postBody.length;

    self.clientCert = {
        key: fs.readFileSync(_assetPath('cc_private.pem')),
        cert: fs.readFileSync(_assetPath('cc_public.pem')),
    };

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
InstanceManager.prototype.reqall = function(url, methods, callback) {
    var self = this;
    var results = {};

    //
    // prepare the resultset
    //

    var reqd = [];
    var results = {};

    for (var id in self.instances) {
        results[id] = {};
        methods.forEach(function(method) {
            results[id][method] = {};
            reqd.push({ inst: id, method: method });
        });
    }

    return async.forEachSeries(reqd, function(d, cb) {
        return self.req(d.inst, d.method, url, function(err, res) {
            if (err) results[d.inst][d.method] = { err: err };
            else results[d.inst][d.method] = res;
            return cb();
        });

    }, function(err) {
        return callback(err, results);
    })

};

//
// Sends three requests to a farm.js instance: http, https and https+cc
//
// @param id Instance ID
// @param url The request URL
// @param callback
//
InstanceManager.prototype.req = function(id, method, url, callback) {
    var self = this;
    var inst = self.instances[id];

    if (!inst) new Error('unknown instance ' + id);
    if (!url) new Error('url is required');
    if (!callback) callback = function() { };

    // parse url
    var parsed = urlparser.parse(url);
    var attempts = 10;

    //
    // For every URL, we are issuing three requests:
    //  (1) Plain old HTTP (expect to fail for non-public apps)
    //  (2) HTTPS without a client cert (expect to fail for non-public apps)
    //  (3) HTTPS with a client cert (expect to succeed on all)
    //

    function _request(protocol, port, cert) {
        return function(cb) {
            var options = {
                url: protocol + "//localhost:" + port + parsed.path,
                method: method,
                headers: {},
                agent: false,
                followRedirect: false,
                
            };

            if (cert) {
                options.key = self.clientCert.key;
                options.cert = self.clientCert.cert;
            }

            options.headers[farmjs.HEADERS.URL] = url;

            if (method === "POST") {
                options.body = self.postBody;
            }

            return request(options, function(err, res, body) {

                if (err) {
                    
                    // retry if we had a connection reset
                    // this can happen due to high load and retry should work
                    if (err.code === "ECONNRESET") {
                        if (--attempts > 0) return setTimeout(function() {
                            console.error('retry after connection reset');
                            return _request(protocol, port, cert)(cb);
                        }, 200);
                        else { 
                            console.error('retries after ECONNRESET exhausted... sorry, this is going to fail');
                        }
                    }

                    return cb(null, { err: err });
                    
                }
                else {

                    return cb(null, res);

                }
            });
        }
    }

    return async.parallel(
    [
        _request('http:', inst.http.port, false),
        _request('https:', inst.https.port, false),
        _request('https:', inst.https.port, true),
    ], 
    function(err, results) {
        if (err) return callback(err);
        return callback(null, {
            'http': results[0],
            'https': results[1],
            'authHttps': results[2]
        });
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
            var handler = require('./testhttphandler');
            var webServer = http.createServer(handler({ webserver:true, inst: id }));
            webServer.listen(port);

            var spinnerRangeStart = 7000 + 100 * index;
            var spinnerRangeEnd = spinnerRangeStart + 100 - 1;
            var spinnerRange = [ spinnerRangeStart, spinnerRangeEnd ];

            var routerOptions = {
                logger: self.logger.pushctx(id), 
                instance: id,
                range: spinnerRange,
                getAppByName: appresolver(port, id),
                getInstances: function(callback) {
                    var instances = {};
                    for (var id in self.instances) {
                        instances[id] = {
                            host: 'localhost',
                            port: self.instances[id].internal.port
                        };
                    }
                    return callback(null, instances);
                },
            };

            router = farmjs.createRouter(routerOptions);
            router.addParentDomain("anodejs.org");
            router.addAppDomain('myapp.net', 'direct');

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
                key: fs.readFileSync(_assetPath('private.pem')),
                cert: fs.readFileSync(_assetPath('public.pem')),
                ca: [ fs.readFileSync(_assetPath('cc_public.pem')) ],
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

function _assetPath(name) {
    return path.join(__dirname, "..", "assets", name);
}
