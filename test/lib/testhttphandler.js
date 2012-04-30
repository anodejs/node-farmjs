module.exports = function(extend) {
    return function(req, res) {
        // sum length of chunks
        var len = 0;
        req.on('data', function(data) { len += data.length; });

        req.on('end', function() {
            var echo = {
                bodyLength: len,
                appname: process.env.FARMJS_APP || req.headers['x-farmjs-app'],
                inst: process.env.FARMJS_INSTANCE,
                port: process.env.PORT,
                argv: process.argv,
                url: req.url,
                headers: req.headers,
                pid: process.pid,
            };

            if (extend) for (var k in extend) echo[k] = extend[k];

            res.writeHead(200, { "content-type": "application/json", "x-echo": JSON.stringify(echo) });
            res.end(JSON.stringify(echo, true, 2));
        });
    };
};

