var testCase = require('nodeunit').testCase;
var farmjs = require('../main');
var urlparser = require('url');
var ctxconsole = require('ctxobj').console;

exports.parseURL = {

	setUp: function(cb) {
		var server = farmjs.createRouter({ instance: 'inst0' });
		this._server = server;

		//
		// Add a parent domain - this means that 'xxx' in urls in the form 'xxx.parent.domain.com' will
		// be resolved as the app.
		//

		this._server.addParentDomain("parent.domain.com");

		// helper test function - calls parseURL.
		this.parse = function(url, headers) {
			var p = urlparser.parse(url);
			var fakereq = {};
			fakereq.url = p.path;
			fakereq.headers = headers || {};
			fakereq.headers.host = p.host;
			fakereq.logger = ctxconsole(console).pushctx('parseurl');

			var secure = p.protocol === "https:" ? true : false;
			return server._parseURL(fakereq, secure);
		};

		cb();			
	},

	tearDown: function(cb) {
		this._server.close(cb);
	},

	normal: function(test) {
		var url = this.parse('http://domain.com:123/myapp/and/path?q=1234&y=hello');
		console.log(url);
		test.deepEqual(url.protocol, "http:");
		test.deepEqual(url.host, "domain.com:123");
		test.deepEqual(url.hostname, "domain.com");
		test.deepEqual(url.port, 123);
		test.deepEqual(url.path, "/and/path?q=1234&y=hello");
		test.deepEqual(url.pathname, "/and/path");
		test.deepEqual(url.query, { q: 1234, y: 'hello' });
		test.deepEqual(url.search, "?q=1234&y=hello");
		test.deepEqual(url.href, "http://domain.com:123/and/path?q=1234&y=hello");
		test.deepEqual(url.hints, {});
		test.deepEqual(url.app, "myapp");
		test.done();
	},

	hints: function(test) {
		var url = this.parse('http://domain.com:123/myapp/and/path?q=1234&y=hello&$flagHint&$hint=poo');
		test.deepEqual(url.protocol, "http:");
		test.deepEqual(url.host, "domain.com:123");
		test.deepEqual(url.hostname, "domain.com");
		test.deepEqual(url.port, 123);
		test.deepEqual(url.path, "/and/path?q=1234&y=hello");
		test.deepEqual(url.pathname, "/and/path");
		test.deepEqual(url.query, { q: 1234, y: 'hello' });
		test.deepEqual(url.search, "?q=1234&y=hello");
		test.deepEqual(url.href, "http://domain.com:123/and/path?q=1234&y=hello");
		test.deepEqual(url.hints, { $flagHint: '', $hint: 'poo' });
		test.deepEqual(url.app, "myapp");
		test.done();
	},

	secure: function(test) {
		var url = this.parse('https://domain.com:123/myapp/and/path?q=1234&y=hello&$flagHint&$hint=poo');
		test.deepEqual(url.protocol, "https:");
		test.deepEqual(url.host, "domain.com:123");
		test.deepEqual(url.hostname, "domain.com");
		test.deepEqual(url.port, 123);
		test.deepEqual(url.path, "/and/path?q=1234&y=hello");
		test.deepEqual(url.pathname, "/and/path");
		test.deepEqual(url.query, { q: 1234, y: 'hello' });
		test.deepEqual(url.search, "?q=1234&y=hello");
		test.deepEqual(url.href, "https://domain.com:123/and/path?q=1234&y=hello");
		test.deepEqual(url.hints, { $flagHint: '', $hint: 'poo' });
		test.deepEqual(url.app, "myapp");
		test.done();
	},
	
	withoutApp: function(test) {
		var url = this.parse('http://domain.com?$a=x');
		test.deepEqual(url.protocol, 'http:');
		test.deepEqual(url.app, 'home');
		test.deepEqual(url.href, 'http://domain.com/');
		test.deepEqual(url.query, {});
		test.deepEqual(url.hints, { $a: 'x' });
		test.done();
	},

	parentDomain: function(test) {
		var url = this.parse('https://myapp.parent.domain.com:123/and/path?q=1234&y=hello&$flagHint&$hint=poo');
		test.deepEqual(url.protocol, "https:");
		test.deepEqual(url.host, "myapp.parent.domain.com:123");
		test.deepEqual(url.hostname, "myapp.parent.domain.com");
		test.deepEqual(url.port, 123);
		test.deepEqual(url.path, "/and/path?q=1234&y=hello");
		test.deepEqual(url.pathname, "/and/path");
		test.deepEqual(url.query, { q: 1234, y: 'hello' });
		test.deepEqual(url.search, "?q=1234&y=hello");
		test.deepEqual(url.href, "https://myapp.parent.domain.com:123/and/path?q=1234&y=hello");
		test.deepEqual(url.hints, { $flagHint: '', $hint: 'poo' });
		test.deepEqual(url.app, "myapp");
		test.done();
	},
};