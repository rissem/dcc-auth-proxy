// TODO probably should have an http port that just redirects to https
// TODO set secure flag on cookies

const passport = require('passport')
const session = require('express-session')
const FileStore = require('session-file-store')(session)
const express = require('express')
const fs = require('fs')
const https = require('https')
const httpProxy = require('http-proxy')
const proxy = httpProxy.createProxyServer({ ws: true })
const requiredEnvVars = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'HOST',
  'PORT',
  'SESSION_SECRET',
  'COOKIE_DOMAIN',
]
const ldap = require('ldapjs')
let ldapClient = null
const cors = require('cors')

const debug = process.env.DEBUG == 1
const allowedIps = !process.env.ALLOWED_IPS
  ? []
  : process.env.ALLOWED_IPS.split(',')
if (debug) console.log('whitelisting IPS', allowedIps)

requiredEnvVars.map((envVar) => {
  if (!process.env[envVar]) {
    console.error('must define environment variable', envVar)
    process.exit(1)
  }
})

//TOOD really publicUrls should be url/service pairs...
const publicUrls = process.env.PUBLIC_URLS
  ? process.env.PUBLIC_URLS.split(',')
  : []
const publicServices = process.env.PUBLIC_SERVICES
  ? process.env.PUBLIC_SERVICES.split(',')
  : []

const app = express()

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  cookie: { domain: '.' + process.env.COOKIE_DOMAIN, secure: true },
  resave: false,
  saveUninitialized: true,
  store: new FileStore(),
})

app.use(
  cors({
    credentials: true,
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://validator.echemdata.com',
      'https://screener.echemdata.com',
      'https://validator.chemdata.com',
      'https://screener.chemdata.com',
      'https://validator.chemdata.net',
      'https://screener.chemdata.net',
    ],
  }),
)

app.use(sessionMiddleware)
app.use(passport.initialize())
app.use(passport.session())
const GoogleStrategy = require('passport-google-oauth20').Strategy

const key = fs.readFileSync('cert/ssl.key', 'utf8')
const cert = fs.readFileSync('cert/ssl.crt', 'utf8')
const port = process.env.PORT || 443

const accessControl = JSON.parse(fs.readFileSync('accessControl.json', 'utf-8'))

passport.serializeUser(function (user, done) {
  done(null, user)
})

passport.deserializeUser(function (user, done) {
  done(null, user)
})

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `https://${process.env.HOST}:${port}/auth/google/callback`,
    },
    function (accessToken, refreshToken, profile, cb) {
      // TODO handle a response with multiple emails
      // so far i've only seen a responses of the form:
      // [ { value: 'USER@gmail.com', type: 'account' } ]
      if (profile.emails.length > 1) {
        return cb(new Error('multiple emails returned'))
      }
      return cb(null, {
        name: profile.displayName,
        email: profile.emails[0].value,
      })
    },
  ),
)

proxy.on('error', function (e) {
  console.error('proxy error', e)
})

app.get('/auth/google', function (req, res, next) {
  passport.authenticate('google', {
    scope: ['profile', 'email'],
  })(req, res, next)
})

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  function (req, res) {
    if (debug) console.log('google callback', req.session.redirect)
    if (req.session.redirect) {
      const redirect = req.session.redirect
      req.session.redirect = null
      res.redirect(redirect)
    } else {
      res.redirect('/')
    }
  },
)

app.get('/logout', function (req, res) {
  req.logout()
  res.redirect(`https://${process.env.HOST}:${port}`)
})

const getService = (req) => {
  const isRoot = req.hostname.split('.').length === 2
  const hostname = isRoot ? 'root' : req.hostname.split('.')[0]
  const service =
    process.env[`SERVICE_${hostname.toUpperCase().replace('-', '')}_HOST`] ||
    hostname
  return service
}

app.get('/authorized', function (req, res) {
  const service = getService(req)
  if (!req.user || getPrivileges(req.user.email, service) == 0) {
    res.status(401).send('Not authorized')
  } else {
    res.status(200).send('OK')
  }
})

app.all('*', function (req, res) {
  const service = getService(req)
  if (debug) console.log('URL ', req.url)
  if (publicServices.indexOf(service) !== -1) {
    return proxyToService(req, res, service, [])
  }

  if (publicUrls.indexOf(req.url) != -1) {
    return proxyToService(req, res, service, [])
  }

  if (
    allowedIps.indexOf(req.connection.remoteAddress.replace('::ffff:', '')) !=
    -1
  ) {
    return proxyToService(req, res, service, [])
  }

  if (debug) console.log('USER', req.user)

  if (service === 'proxy') return renderFrontPage(req, res)
  if (!req.user) {
    if (debug)
      console.log(
        'no user found on request object, redirecting to google...',
        req.url,
        req.connection.remoteAddress,
      )
    req.session.redirect = `https://${req.hostname}:${port}${req.url}`
    return res.redirect('/auth/google')
  }
  const privileges = getPrivileges(req.user.email, service)
  if (debug)
    console.log(
      'found user',
      req.user.email,
      'with prvileges',
      privileges.join(','),
    )
  if (privileges.length > 0) {
    return proxyToService(req, res, service, privileges)
  } else {
    res.status(401).send('Access denied')
  }
})

// returns privileges based on access control
// Ex: if accessControl contained {"mike@example.com": [redwood.admin]}
//     and service was redwood ['admin'] would be returned
const getPrivileges = function (email, service) {
  if (ldapClient) {
    ldapClient.search(process.env.LDAP_LOGIN, function (err, res) {
      if (err) {
        console.error('err', err)
      }
      res.on('searchEntry', function (entry) {
        console.log('entry: ' + JSON.stringify(entry.object))
      })
      res.on('searchReference', function (referral) {
        console.log('referral: ' + referral.uris.join())
      })
      res.on('error', function (err) {
        console.error('error: ' + err.message)
      })
      res.on('end', function (result) {
        console.log('status: ' + result.status)
      })
    })
  }

  return (accessControl[email] || [])
    .filter((priv) => {
      return priv.startsWith(service)
    })
    .map((priv) => {
      return priv.split('.')[1]
    })
}

const renderFrontPage = function (req, res) {
  if (!req.user) {
    res.send(`<a href="/auth/google">Login with Google</a>`)
  } else {
    res.send(
      `You are currently logged in as ${req.user.name} <a href="/logout">Logout</a>`,
    )
  }
}

const proxyToService = function (req, res, service, privileges) {
  const port =
    process.env[`SERVICE_${service.toUpperCase().replace('-', '')}_PORT`]
  if (!port) {
    return res
      .status(500)
      .send(`Configuration error, service ${service.toUpperCase()} not defined`)
  }
  const target = `http://${service}:${port}`
  const headers = { dcc_privileges: privileges }
  if (req.user) headers.REMOTE_USER = req.user.email.split('@')[0]
  proxy.web(req, res, {
    target,
    headers,
  })
}

const httpsServer = https.createServer({ key, cert }, app)
httpsServer.listen(port)

httpsServer.on('upgrade', function (req, socket, head) {
  sessionMiddleware(req, {}, () => {
    const service = socket.servername.split('.')[0]
    const port = process.env[`SERVICE_${service.toUpperCase()}_PORT`]
    const privileges = getPrivileges(req.session.passport.user.email, service)
    if (privileges.length > 0) {
      proxy.ws(req, socket, head, { target: `http://${service}:${port}` })
    }
  })
})

if (process.env.HTTP_PORT) {
  const app = express()
  app.all('*', function (req, res, next) {
    res.redirect(`https://${req.hostname}${req.url}`)
  })
  app.listen(process.env.HTTP_PORT, function () {
    console.log(`http server listening on port ${process.env.HTTP_PORT}`)
  })
}
