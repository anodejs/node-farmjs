var path = require('path');
var fs = require('fs');

// returns an app resolver function which resolves apps based
// the contents of 'workdir/app.json'.
module.exports = function(webServerPort) {
	if (!webServerPort) throw new Error('webServerPort required');
	
	var workdir = path.join(__dirname, 'workdir');
	var appsData = fs.readFileSync(path.join(workdir, 'apps.json'));
	var apps = JSON.parse(appsData);

	// add path to index file, damn it
	for (var appname in apps) {
		var app = apps[appname];

		if (app.type === "node") {
			var script = path.join(workdir, app.index);
			app.spawn = {
				name: app.name,
				command: process.execPath,
				args: [ script ],
				monitor: script,
			};

			// this will be the contents of the index file.
			var indexTemplate = function() {
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
			};

			var indexContents = "(" + indexTemplate.toString() + ")();";
			fs.writeFileSync(script, indexContents);
		}
		else {

			app.proxy = {
				host: 'localhost',
				port: webServerPort,
				headers: {
					'x-nospawn': 'yes',
					'x-anodejs-rewrite': app.index
				}
			};

		}
	}

	/*
	var jsonFile = path.join(__dirname, "apps." + Math.round(Math.random() * 10000) + ".json");
	fs.writeFileSync(jsonFile, JSON.stringify(self.apps, true, 2));
	self.log("Apps stored under:", jsonFile);
	*/

	return function(logger, name, callback) {
		logger.info('getappbyname called with', name);

		if (!(name in apps)) {
			callback(new Error("app '" + name + "' not found"));
			return;
		}

		callback(null, apps[name]);
	};
};