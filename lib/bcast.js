var async = require('async');
var http = require('http');

/**
* Sends all the requests in the array `requests` in parallel
* and collects the _header_ responses (without the body). Calls `callback` with an object
* that contains the results.
*
* Requests adhere to the nodejs request object with some special properties:
*  - `name` - Required. Used to identify this request in the broadcast result hash.
*  - `body` - Optional. A ReadableStream used as body. Make sure it is paused so that events are not lost.
*  - `timeout` - Options. Timeout in ms to wait for a response for each request (default is 30000)
*/
exports.broadcast = function (requests, callback) {
  var responses = {};

  return async.forEach(requests, function (req, cb) {

    if (!req.name) return cb(new Error("requests must have a `name` property"));
    var timeout = req.timeout || 30000;

    var resp = responses[req.name] = {};

    var r = http.request(req);

    r.on('response', function (res) {
      resp.statusCode = res.statusCode;
      resp.headers = res.headers;
      return cb();
    });

    r.on('error', function (err) {
      resp.err = err;
      return cb();
    });

    r.setTimeout(timeout, function () {
      resp.err = new Error("timeout");
      return cb();
    });

    // pipe body stream if provided, otherwise, just end.
    if (req.body) {
      req.body.setMaxListeners(0); // unlimited listeners
      req.body.pipe(r);
      return req.body.resume();
    }
    else {
      // no body, just end.
      return r.end();
    }

  }, function (err) {
    if (err) return callback(err);
    else return callback(null, responses);
  });
};

/*
//
// buffer response body
//

var chunks = [];
res.on('data', function(data) { return chunks.push(data); });

//
// wait for the response to be terminates
//

res.on('end', function() { return _terminate(); });
res.on('close', function() { return _terminate({ err: "connection closed" }); })

//
// this is called to terminate the request
//

function _terminate(extend) {
if (extend) for (var k in extend) resp[k] = extend[k];
resp.statusCode = res.statusCode;
resp.headers = res.headers;
//if (chunks) resp.body = chunks;
return cb();
}
*/