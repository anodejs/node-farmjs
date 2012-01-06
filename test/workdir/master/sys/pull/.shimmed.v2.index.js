(function () {
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
			})();