(async function() { // IIFE
  const app = require('express')()
      , ln  = require('lightning-client')(process.env.LN_PATH)

  // Test connection
  function connFailed(err) { throw err }
  ln.on('error', connFailed)
  const lninfo = await ln.getinfo()
  ln.removeListener('error', connFailed)
  console.log(`Connected to c-lightning ${lninfo.version} with id ${lninfo.id} on network ${lninfo.network} at ${ln.rpcPath}`)

  // Settings
  app.set('port', process.env.PORT || 9737)
  app.set('host', process.env.HOST || 'localhost')
  app.set('trust proxy', process.env.PROXIED || 'loopback')
  app.set('tls', !process.env.NO_TLS && (app.settings.host !== 'localhost' || process.env.FORCE_TLS))

  // Middlewares
  app.use(require('morgan')('dev'))
  app.use(require('./auth')(app, process.env.LOGIN, process.env.ACCESS_KEY))
  app.use(require('body-parser').json())
  app.use(require('helmet')({ contentSecurityPolicy: { directives: {
    defaultSrc: [ "'self'" ]
  , scriptSrc:  [ "'self'", "'unsafe-eval'" ]
  , fontSrc:    [ "'self'", 'data:' ]
  , imgSrc:     [ "'self'", 'data:' ]
  } }, ieNoOpen: false }))

  // Gzip compression (disabled for SSE https://github.com/jshttp/mime-db/pull/138)
  const compression = require('compression')
  app.use(compression({ filter: (req, res) =>
    compression.filter(req, res) && res.getHeader('Content-Type').split(';')[0] !== 'text/event-stream' }))

  // CSRF protection. Require the X-Access header or access-key query string arg for POST requests.
  app.post('*', (req, res, next) => !req.csrfSafe ? res.sendStatus(403) : next())

  // RPC API
  app.post('/rpc', (req, res, next) =>
    ln.call(req.body.method, req.body.params)
      .then(r => res.send(r)).catch(next))

  // Streaming API
  app.get('/stream', require('./stream')(ln.rpcPath))

  // Frontend
  process.env.NO_WEBUI || require('./webui')(app)

  // Error handler
  app.use((err, req, res, next) => {
    console.error(err.stack || err.toString())
    res.status(err.status || 500).send(err.type && err || err.stack || err)
  })

  // HTTPS server (the default for non-localhost hosts)
  app.enabled('tls')
  ? require('./transport/tls')(app, process.env.TLS_NAME, process.env.TLS_PATH)
      .then(url => serviceReady('HTTPS server', url))

  // HTTP server (for localhost or when --no-tls is specified)
  : require('./transport/http')(app).then(url => serviceReady('HTTP server', url))

  // Tor Onion Hidden Service
  process.env.ONION && require('./transport/onion')(app, process.env.ONION_PATH)
    .then(url => serviceReady('Tor Onion Hidden Service v3', url))

  const qrterm  = process.env.PRINT_QR && require('qrcode-terminal')
      , hashKey = process.env.PAIRING_QR ? `#access-key=${app.settings.accessKey}` : ''

  function serviceReady(name, url) {
    console.log(`${name} running on ${url}`)
    qrterm && qrterm.generate(`${url}${hashKey}`, { small: true })
    hashKey && console.log('[NOTE: This QR contains your secret access key, which provides full access to your wallet]')

    process.send && process.send({ serverUrl: url })
  }

  process.env.PRINT_KEY && console.log('Access key for remote API access:', app.settings.accessKey)
})()

;[ 'unhandledRejection', 'uncaughtException' ].forEach(ev =>
  process.on(ev, err => {
    process.send && process.send({ error: err.toString() })
    console.error(`${ ev }, stopping process`)
    console.error(err.stack || err)
    process.exit(1)
  })
)
