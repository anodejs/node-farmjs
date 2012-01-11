var path = require('path');
var fs = require('fs');

// returns an app resolver function which resolves apps based
// the contents of 'workdir/app.json'.
module.exports = function(webServerPort) {
    if (!webServerPort) throw new Error('webServerPort required');
    
    var workdir = path.join(__dirname, '..', 'workdir');
    var appsData = fs.readFileSync(path.join(workdir, 'apps.json'));
    var apps = JSON.parse(appsData);

    // add path to index file, damn it
    for (var appname in apps) {
        var app = apps[appname];

        app.decision = {
            public: app.public,
            secure: app.secure,
            action: { },
        };

        if (app.type === "node") {
            var script = path.join(workdir, app.index);

            app.decision.action.spawn = {
                name: app.name,
                command: process.execPath,
                args: [ script ],
                monitor: script,
            };

            var handler = require('./testhttphandler');

            var contents = '';
            contents += "var http = require('http');\n";
            contents += "var extend = null;\n";
            contents += "http.createServer(" + handler().toString() + ").listen(process.env.PORT);\n";
            contents += "console.log('app started on port', process.env.PORT);\n";
            fs.writeFileSync(script, contents);
        }
        else {
            app.decision.action.proxy = {
                host: 'localhost',
                port: webServerPort,
                headers: {
                    'x-nospawn': 'yes',
                    'x-anodejs-rewrite': app.index
                },
            };
        }

        if (app.blocked) {
            app.decision.action = {};
            app.decision.action.error = {
                status: 403,
                msg: "app is blocked because it is defined as a worker and workers can only run from the default branch ('rp.sys')",
            };
        }

        if (app.alias) {
            app.decision.action = {};
            app.decision.action.alias = {
                target: app.alias.target
            };
        }
    }

    return function(req, name, callback) {
        req.logger.log('getappbyname called with', name);

        if (!(name in apps)) {
            callback(new Error("app '" + name + "' not found"));
            return;
        }

        var decision = apps[name].decision;
        req.logger.log('app decision:', JSON.stringify(decision));
        return callback(null, decision);
    };
};