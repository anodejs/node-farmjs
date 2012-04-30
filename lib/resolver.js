/**
* Resolves app names from URLs.
* Supports 3 types of addressing:
*  - Subdomains (appname.domain.com)
*  - Path (domain.com/appname)
*  - App domains (myapp.com)
*
* For subdomains and path-based resolve, 'home' will be used
* as the default app.
*/
function Resolver() {

  // uniqified array
  this.rootDomainsHash = {};
  this.__defineGetter__('rootDomains', function () {
    return Object.keys(this.rootDomainsHash);
  });

  this.appDomains = {};
  this.defaultApp = 'home';
}

// adds a root domain (a domain resolves as *.domainname) where * is the app name
Resolver.prototype.addRootDomain = function (rootDomain) {
  rootDomain = rootDomain.toLowerCase();
  this.rootDomainsHash[rootDomain] = true;
};

// adds a domain that maps to a specific app
Resolver.prototype.addAppDomain = function (domain, app) {
  this.appDomains[domain] = app;
};

// resolves a URL and returns the app name for that domain
// or null if there was no match
Resolver.prototype.resolve = function (hostname, pathname) {
  var self = this;
  var app = null;

  function resolveAsAppDomain() {
    var appDomain;
    for (appDomain in self.appDomains) {
      if (self.appDomains.hasOwnProperty(appDomain) && subdomain(hostname, appDomain) !== null) {
        return { app: self.appDomains[appDomain], pathname: pathname };
      }
    }
    return null;
  }

  function resolveAsRootDomain() {
    // look up to see if the host name matches any of the allowed domains
    var app = null;

    for (var i in self.rootDomains) {
      app = subdomain(hostname, self.rootDomains[i]);
      if (app) {
        break;
      }
    }

    if (app === 'www') {
      app = null; // www is not a subdomain
    }

    return app ? { app: app, pathname: pathname} : null;
  }

  function resolveAsPath() {
    var path = pathname.split('/');

    path.shift(); // remove first empty string in liu of the first '/'.

    var appName = path[0];
    if (appName) {
      path.shift();
    }

    var targetUrl = '/' + path.join('/');

    return (appName) ? { app: appName, pathname: targetUrl, rootpath: '/' + appName} : null;
  }

  app =
        resolveAsAppDomain() ||
        resolveAsRootDomain() ||
        resolveAsPath() ||
        { app: self.defaultApp, rootpath: '/' + self.defaultApp };

  if (!app.pathname) app.pathname = "/";

  return app;
};

exports.Resolver = Resolver;

//
// utility functions
//

// returns the subdomain of 'domain' under 'root' or null if 'domain' is not a subdomain
// of 'root'. e.g. subdomain('x.y.z', 'y.z') === 'x'.
// note that an empty string (domain==root) is not the same as null.
function subdomain(domain, root) {
  if (!domain) return null;
  var i = domain.indexOf(root);
  if (i >= 0 && domain.substring(i) === root) {
    return domain.substring(0, i - 1);
  } else {
    return null;
  }
}
