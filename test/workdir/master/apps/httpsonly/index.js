var http = require('http');
http.createServer(function(req, res) {
    res.end('started');
}).listen(process.env.PORT);
console.log('starting app on port', process.env.PORT);
