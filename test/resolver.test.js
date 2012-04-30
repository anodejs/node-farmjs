var urlparser = require('url');
var Resolver = require('../lib/resolver').Resolver;

var path = [
  { from: 'http://localhost:8888/xyz',                 app: 'xyz',             pathname: '/'      },
  { from: 'http://localhost:8888/xyz/1234',            app: 'xyz',             pathname: '/1234'  },
  { from: 'http://localhost:8888/xyz/',                app: 'xyz',             pathname: '/'      },
  { from: 'http://localhost:8888/xyz/?q=66',           app: 'xyz',             pathname: '/'      },
  { from: 'http://localhost:8888/xyz?q=66',            app: 'xyz',             pathname: '/'      },
  { from: 'http://localhost:8888/xyz/hello?q=3&j=4',   app: 'xyz',             pathname: '/hello' },
  { from: 'http://localhost:8888/thisismyservice',     app: 'thisismyservice', pathname: '/'      },
  { from: 'http://server1/xyz/1234',                   app: 'xyz',             pathname: '/1234'  },
  { from: 'http://localhost:1234',                     app: 'home',            pathname: '/'      },
  { from: 'http://127.0.0.1:8888/xyz',                 app: 'xyz',             pathname: '/'      },
  { from: 'http://192.168.1.5:333/xyz?q=4',            app: 'xyz',             pathname: '/'      },
  { from: 'http://anode-eladb2.cloudapp.net/xyz?q=4',  app: 'xyz',             pathname: '/'      },
];

var domain_path = [
  { from: 'http://anodejs.org/thisismyservice',        app: 'thisismyservice', pathname: '/'      },
  { from: 'http://www.anodejs.org/thisismyservice',    app: 'thisismyservice', pathname: '/'      },
  { from: 'http://anodejs.org/home/b/c?q=1',           app: 'home',            pathname: '/b/c'   },
  { from: 'http://my.org/home/b/c?q=1',                app: 'home',            pathname: '/b/c'   },
  { from: 'http://www.my.org/home/b/c?q=1',            app: 'home',            pathname: '/b/c'   },
  { from: 'http://www.anodejs.org/?q=1',               app: 'home',            pathname: '/'      }
];

var subdomain = [
  { from: 'http://anodejs.org',                        app: 'home',            pathname: '/'      },
  { from: 'http://xyz.anodejs.org',                    app: 'xyz',             pathname: '/'      },
  { from: 'http://hello.world.anodejs.org',            app: 'hello.world',     pathname: '/'      },
  { from: 'http://foo.my.domain.org:1234/a/b/c?q=4',   app: 'foo',             pathname: '/a/b/c' },
];

var app_domains = [
    { from: 'http://myapp.com',                        app: 'myapp',           pathname: '/'      },
    { from: 'http://xxx.myapp.com',                    app: 'myapp',           pathname: '/'      },
    { from: 'http://a.b.c.myapp.com/y/z/s?hgt=555',    app: 'myapp',           pathname: '/y/z/s' },
    { from: 'http://api.yourapp.com',                  app: 'yourapp',         pathname: '/'      },
    { from: 'http://noresolve.yourapp.com',            app: 'home',            pathname: '/'      }, // this is basically the same as an unknown domain
    { from: 'http://hhh.api.yourapp.com',              app: 'yourapp',         pathname: '/'      }
];

var nonjs = [
  { from: 'http://aspnet.demos.anodejs.org/a/b/c?a=5', app: 'aspnet.demos',   pathname: '/a/b/c'  }
];

var case_groups = [path, domain_path, subdomain, nonjs, app_domains];

function testFactory(c) {
    return function(test) {
        var d = new Resolver();

        d.addRootDomain('anodejs.org');
        d.addRootDomain('my.domain.org');
        d.addAppDomain('myapp.com', 'myapp');
        d.addAppDomain('api.yourapp.com', 'yourapp');

        var url = urlparser.parse(c.from);

        var result = d.resolve(url.hostname, url.pathname);
        test.equals(result.app, c.app, "source: " + c.from);
        test.equals(result.pathname, c.pathname, "source: " + c.from); 
        
        test.done();
    };
};

case_groups.forEach(function(g) {
    g.forEach(function(c) {
        exports[c.from] = testFactory(c);
    });
});

/**
 * verfies that when you add a domain twice, it ignores the second add
 */
exports.rootDomainUniqness = function(test) {
    var resolver = new Resolver();
    test.deepEqual(resolver.rootDomains, []);
    resolver.addRootDomain('moshe.com');
    test.deepEqual(resolver.rootDomains, [ 'moshe.com' ]);
    resolver.addRootDomain('booboo.com');
    test.deepEqual(resolver.rootDomains, [ 'moshe.com', 'booboo.com' ]);
    resolver.addRootDomain('moshe.com');
    resolver.addRootDomain('moshe.com');
    resolver.addRootDomain('moshe.com');
    resolver.addRootDomain('googoo.com');
    resolver.addRootDomain('booboo.com');
    resolver.addRootDomain('booboo.com');
    resolver.addRootDomain('booboo.com');
    resolver.addRootDomain('booboo.com');
    test.deepEqual(resolver.rootDomains, [ 'moshe.com', 'booboo.com', 'googoo.com' ]);
    test.done();
};
