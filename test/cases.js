//
// Test cases for farm.js app requests
// Corresponds the apps defined under the git repository under 'workdir'
//

exports.$default = {
    http:      { status: 401 },
    https:     { status: 401 },
    authHttps: { status: 200, url: '/' }
};

/**
 * Node.js apps spawned and port-allocated automatically upon request
 */
exports.tests = [

    //
    // spawn a few node.js apps, test a few url and query variations
    //

    { 
        from: 'http://test.anodejs.org/1/2/3/4?q=5', 
        expected: { 
            authHttps: { spawn: '$/master/apps/test/.shimmed.v2.index.js', url: '/1/2/3/4?q=5', app: 'test' },
        }
    },

    { 
        from: 'http://anodejs.cloudapp.net/apps?$app=test', 
        expected: {
            authHttps: { spawn: '$/master/apps/test/.shimmed.v2.index.js', url: '/apps', app: 'test' },
        },
    },

    { 
        from: 'http://test.anodejs.org/1/2/3/4?q=5',
        expected: { 
            authHttps: { spawn: '$/master/apps/test/.shimmed.v2.index.js', url: '/1/2/3/4?q=5', app: 'test' },
        }
    },

    { 
        from: 'http://pull.sys.anodejs.org',
        expected: { 
            authHttps: { spawn: '$/master/sys/pull/.shimmed.v2.index.js', app: 'pull.sys' },
        }
    },

    { 
        from: 'http://direct.anodejs.org/12345',
        expected: { 
            authHttps: { spawn: '$/master/apps/direct/.shimmed.v2.index.js', url: '/12345', app: 'direct' },
        }
    },

    { 
        from: 'http://direct2.anodejs.org/1234599',
        expected: { 
            authHttps: { spawn: '$/master/apps/direct2/.shimmed.v2.index.js', url: '/1234599', app: 'direct2' },
        }
    },

    { 
        from: 'http://direct2.anodejs.org/1234599/1234',
        expected: { 
            authHttps: { spawn: '$/master/apps/direct2/.shimmed.v2.index.js', url: '/1234599/1234', app: 'direct2' },
        }
    },

    //
    // spawn an app via an alias ('direct-alias' is an alias for 'direct')
    //

    { 
        from: 'http://direct-alias.anodejs.org/1234588', 
        expected: {
            authHttps: { spawn: '$/master/apps/direct/.shimmed.v2.index.js', url: '/1234588', app: 'direct' },
        },
    },

    //
    // use $app=test to override any app decision
    //

    { 
        from: 'http://tooooooooooooo.anodejs.org/a/b/c?$app=test&a=1', 
        expected: {
            authHttps: { spawn: '$/master/apps/test/.shimmed.v2.index.js', url: '/a/b/c?a=1', app: 'test' },
        },
    },

    //
    // spawn an app that resides in a branch ('foofoo.branch9') and make sure the x-farmjs-app
    // in the header is resolves to the basename (in this case, 'foofoo')
    //

    { 
        from: 'http://foogoo.branch9.anodejs.org', 
        expected: {
            authHttps: { spawn: '$/branch9/apps/foogoo/.shimmed.v2.index.js', url: '/', app: 'foogoo' },
        },
    },

    //
    // try to access a public app (named 'public'). 'public: true' indicates to the harness
    // that the app should be accessible via http and https without a client certificate
    //

    { 
        from: 'http://public.anodejs.org/1/2/3/4?q=5', 
        expected: { $default : { status: 200, spawn: '$/master/apps/public/.shimmed.v2.index.js', url: "/1/2/3/4?q=5", app: 'public' } },
    },

    //
    // try to access an app that does not exist and expect a 404
    //

    { 
        from: 'http://foo.goo.anodejs.org/p/a/t/h', 
        expected: { $default: { status: 404 } },
    },
    //
    // these apps are marked as 'proxy' and not 'spawn', in which case we do not expect anything to be
    // spawned, but we expect the request to be proxied appropriately and headers piggybacked on
    // the request. hello.world is also public, so verify that as well.
    //

    { 
        from: 'http://anodejs.cloudapp.net/hooligan/foo/goo?a=6', 
        expected: {
            authHttps: { proxy: true, headers: { 'x-anodejs-rewrite': 'master/apps/hooligan/index.svc' }, url: '/foo/goo?a=6', app: 'hooligan' },
        },
    },
    { 
        from: 'http://hello.world.anodejs.org/', 
        expected: {
            $default: { status: 200, proxy: true, headers: { 'x-anodejs-rewrite': 'master/apps/world/hello/index.aspx' }, url: '/', app: 'hello.world' },
        },
    },

    { 
        from: 'http://anodejs.org/hello.world', 
        expected: {
            $default: { status: 200, proxy: true, headers: { 'x-anodejs-rewrite': 'master/apps/world/hello/index.aspx' }, url: '/', app: 'hello.world' },
        },
    },


    //
    // this app is tagged with { secure: true }, which means we expect a redirect from http to https
    //

    { 
        from: 'http://httpsonly.anodejs.org/path?q=1&$hint=y', 
        expected: {
            http:      { status: 302, redirect: "https://httpsonly.anodejs.org/path?q=1&$hint=y" },
            https:     { status: 401 },
            authHttps: { status: 200, spawn: '$/master/apps/httpsonly/.shimmed.v2.index.js', app: 'httpsonly', url: '/path?q=1' },
        },
    },

    //
    // $inst will direct the request to a different instance of the farm. the test harness creates
    // a farm with 5 instances.
    //

    { 
        from: 'http://test.anodejs.org/path?q=1&$inst=unknown', 
        expected: {
            authHttps: { status: 400 },
        },
    },

    { 
        from: 'http://test.anodejs.org/path?q=1&$inst=inst1', 
        expected: {
            authHttps: { spawn: '$/master/apps/test/.shimmed.v2.index.js', url: '/path?q=1', instance: 'inst1', app: 'test' },
        },
    },

    { 
        from: 'http://test.anodejs.org/path?q=1&$inst=inst2', 
        expected: {
            authHttps: { spawn: '$/master/apps/test/.shimmed.v2.index.js', url: '/path?q=1', instance: 'inst2', app: 'test' },
        }
    },

    //
    // blocked (forbidden) app ({ blocked !== null })
    //

    { 
        from: 'http://rp.sys.branch9.anodejs.org/forbidden', 
        expected: {
            authHttps: { status: 403, body: { msg: "app is blocked because it is defined as a worker and workers can only run from the default branch ('rp.sys')" } },
        },
    },

    //
    // $bcast will cause the request to be sent to all instances and results
    // aggregated. if $bcast points to a url, it will be used as postback
    // with the body of the results. otherwise, only headers and status are echoed back
    //

    {
        from: 'http://test.anodejs.org/path?q=123&$bcast',
        expected: {
            authHttps: { status: 200, bcast: true, url: '/path?q=123' },
        },
    },
];

// { from: 'http://hello.world.anodejs.org/longrunningshit?$postback=http://localhost:6000?bla=1&param1=1234', postback: "http://localhost:6000", to: "http://hello.world.anodejs.org/longrunningshit?param1=1234" },
// { from: 'http://bla.bla.bla.anodejs.org/favicon.ico', error: 200 },
// { from: 'http://anything.anodejs.org/robots.txt', error: 404 },
// { from: 'http://rp.sys.anodejs.org', error: 400 },
// { from: 'http://test.anodejs.org/a/b?$llog=BADINST', error: 404 },
// { from: 'http://test.anodejs.org/a/b?$llog', error: 400 },
// { from: 'http://hello.world.anodejs.org/a/b/c?$llog', spawn: '$/master/apps/world/hello/index.aspx', path:'/a/b/c' },
// { from: 'http://test.anodejs.org/a/b?$llog=instance9', spawn: '$/master/apps/test/.shimmed.v2.index.js.logs/0.txt', path: '/a/b', app: 'test' },
// { from: 'http://test.anodejs.org/1/2/3/4?q=5&$log', redirect: 'http://logs.sys.anodejs.org/index.html?app=test' },
// { from: 'http://test.anodejs.org/1/2/3/4?q=5&$dash', redirect: 'http://logs.sys.anodejs.org/index.html?app=test' },
