'use strict';

/**
 * Lightweight web framework for your serverless applications
 * @author Jeremy Daly <jeremy@jeremydaly.com>
 * @version 0.3.0
 * @license MIT
 */

const REQUEST = require('./request.js') // Response object
const RESPONSE = require('./response.js') // Response object
const Promise = require('bluebird') // Promise library

// Create the API class
class API {

  // Create the constructor function.
  constructor(props) {

    // Set the version and base paths
    this._version = props && props.version ? props.version : 'v1'
    this._base = props && props.base && typeof props.base === 'string' ? props.base.trim() : ''
    this._callbackName = props && props.callback ? props.callback.trim() : 'callback'
    this._mimeTypes = props && props.mimeTypes && typeof props.mimeTypes === 'object' ? props.mimeTypes : {}

    // Prefix stack w/ base
    this._prefix = this.parseRoute(this._base)

    // Stores timers for debugging
    this._timers = {}
    this._procTimes = {}

    // Stores route mappings
    this._routes = {}

    // Default callback
    this._cb = function(err,res) { console.log('No callback specified') }

    // Middleware stack
    this._middleware = []

    // Error middleware stack
    this._errors = []

    // Store app packages and namespaces
    this._app = {}

    // Keep track of callback execution
    this._done = false

    // Executed after the callback
    this._finally = () => {}

    // Promise placeholder for final route promise resolution
    this._promise = function() { console.log('no promise to resolve') }
    this._reject = function() { console.log('no promise to reject') }

    // Global error status
    this._errorStatus = 500

    // Testing flag
    this._test = false

  } // end constructor

  // GET: convenience method
  get(path, handler) {
    this.METHOD('GET', path, handler)
  }

  // POST: convenience method
  post(path, handler) {
    this.METHOD('POST', path, handler)
  }

  // PUT: convenience method
  put(path, handler) {
    this.METHOD('PUT', path, handler)
  }

  // PATCH: convenience method
  patch(path, handler) {
    this.METHOD('PATCH', path, handler)
  }

  // DELETE: convenience method
  delete(path, handler) {
    this.METHOD('DELETE', path, handler)
  }

  // OPTIONS: convenience method
  options(path, handler) {
    this.METHOD('OPTIONS', path, handler)
  }

  // METHOD: Adds method and handler to routes
  METHOD(method, path, handler) {

    // Parse the path
    let parsedPath = this.parseRoute(path)

    // Split the route and clean it up
    let route = this._prefix.concat(parsedPath)

    // For root path support
    if (route.length === 0) { route.push('')}

    // Keep track of path variables
    let pathVars = {}

    // Loop through the paths
    for (let i=0; i<route.length; i++) {

      // If this is a variable
      if (/^:(.*)$/.test(route[i])) {
        // Assign it to the pathVars (trim off the : at the beginning)
        pathVars[i] = route[i].substr(1)
        // Set the route to __VAR__
        route[i] = '__VAR__'
      } // end if variable

      // Add the route to the global _routes
      this.setRoute(
        this._routes,
        (i === route.length-1 ? { ['__'+method.toUpperCase()]: { vars: pathVars, handler: handler, route: '/'+parsedPath.join('/') } } : {}),
        route.slice(0,i+1)
      );

    } // end for loop

  } // end main METHOD function


  // RUN: This runs the routes
  run(event,context,cb) { // TODO: Make this dynamic

    this.startTimer('total')

    this._done = false

    // Set the event, context and callback
    this._event = event
    this._context = context
    this._cb = cb

    // Initalize response object
    let response = new RESPONSE(this)
    let request = {}

    Promise.try(() => { // Start a promise

      // Initalize the request object
      request = new REQUEST(this)

      // Execute the request
      return this.execute(request,response)

    }).catch((e) => {

      // Error messages should never be base64 encoded
      response._isBase64 = false

      // Strip the headers (TODO: find a better way to handle this)
      response._headers = {}

      let message;

      if (e instanceof Error) {
        response.status(this._errorStatus)
        message = e.message
        !this._test && console.log(e)
      } else {
        message = e
        !this._test && console.log('API Error:',e)
      }

      // Execute error middleware
      if (this._errors.length > 0) {

        // Init stack queue
        let queue = []

        // Loop through the middleware and queue promises
        for (let i in this._errors) {
          queue.push(() => {
            return new Promise((resolve, reject) => {
              this._promise = () => { resolve() } // keep track of the last resolve()
              this._reject = (e) => { reject(e) } // keep track of the last reject()
              this._errors[i](e,request,response,() => { resolve() }) // execute the errors with the resolve callback
            }) // end promise
          }) // end queue
        } // end for

        // Return Promise.each serialially
        return Promise.each(queue, function(queue_item) {
          return queue_item()
        }).then(() => {
          response.json({'error':message})
        })

      } else {
        response.json({'error':message})
      }

    }).finally(() => {
      this._finally(request,response)
    })
  } // end run function


  // Custom callback
  _callback(err, res) {

    // Resolve any outstanding promise
    this._promise()

    this._done = true

    this.endTimer('total')

    if (res) {
      if (this._debug) {
        console.log(this._procTimes)
      }
    }

    // Execute the primary callback
    this._cb(err,res)

  } // end _callback


  // Middleware handler
  use(fn) {
    if (fn.length === 3) {
      this._middleware.push(fn)
    } else if (fn.length === 4) {
      this._errors.push(fn)
    } else {
      throw new Error('Middleware must have 3 or 4 parameters')
    }
  } // end use

  // Finally function
  finally(fn) {
    this._finally = fn
  }

  // Process
  execute(req,res) {

    // Init stack queue
    let queue = []

    // If execute is called after the app is done, just return out
    if (this._done) { return; }

    // If there is middleware
    if (this._middleware.length > 0) {
      // Loop through the middleware and queue promises
      for (let i in this._middleware) {
        queue.push(() => {
          return new Promise((resolve, reject) => {
            this._promise = () => { resolve() } // keep track of the last resolve()
            this._reject = (e) => { reject(e) } // keep track of the last reject()
            this._middleware[i](req,res,() => { resolve() }) // execute the middleware with the resolve callback
          }) // end promise
        }) // end queue
      } // end for
    } // end if

    // Push the main execution path to the queue stack
    queue.push(() => {
      return new Promise((resolve, reject) => {
        this._promise = () => { resolve() } // keep track of the last resolve()
        this._reject = (e) => { reject(e) } // keep track of the last reject()
        this.handler(req,res) // execute the handler with no callback
      })
    })

    // Return Promise.each serialially
    return Promise.each(queue, function(queue_item) {
      return queue_item()
    })

  } // end execute



  //-------------------------------------------------------------------------//
  // TIMER FUNCTIONS
  //-------------------------------------------------------------------------//

  // Returns the calculated processing times from all stopped timers
  getTimers(timer) {
    if (timer) {
      return this._procTimes[timer]
    } else {
      return this._procTimes
    }
  } // end getTimers

  // Starts a timer for debugging purposes
  startTimer(name) {
    this._timers[name] = Date.now()
  } // end startTimer

  // Ends a timer and calculates the total processing time
  endTimer(name) {
    try {
      this._procTimes[name] = (Date.now()-this._timers[name]) + ' ms'
      delete this._timers[name]
    } catch(e) {
      console.error('Could not end timer: ' + name)
    }
  } // end endTimer


  //-------------------------------------------------------------------------//
  // UTILITY FUNCTIONS
  //-------------------------------------------------------------------------//

  parseRoute(path) {
    return path.trim().replace(/^\/(.*?)(\/)*$/,'$1').split('/').filter(x => x.trim() !== '')
  }


  setRoute(obj, value, path) {
    if (typeof path === "string") {
        let path = path.split('.')
    }

    if (path.length > 1){
      let p = path.shift()
      if (obj[p] === null) { // || typeof obj[p] !== 'object') {
        obj[p] = {}
      }
      this.setRoute(obj[p], value, path)
    } else {
      if (obj[path[0]] === null) { // || typeof obj[path[0]] !== 'object') {
        obj[path[0]] = value
      } else {
        obj[path[0]] = Object.assign(value,obj[path[0]])
      }
    }
  } // end setRoute


  // Load app packages
  app(packages) {

    // Check for supplied packages
    if (typeof packages === 'object') {
      // Loop through and set package namespaces
      for (let namespace in packages) {
        try {
          this._app[namespace] = packages[namespace]
        } catch(e) {
          console.error(e.message)
        }
      }
    } else if (arguments.length === 2 && typeof packages === 'string') {
      this._app[packages] = arguments[1]
    }// end if

    // Return a reference
    return this._app
  }


  // Register routes with options
  register(fn,options) {

    // Extract Prefix
    let prefix = options.prefix && options.prefix.toString().trim() !== '' ?
      this.parseRoute(options.prefix) : []

    // Concat to existing prefix
    this._prefix = this._prefix.concat(prefix)

    // Execute the routing function
    fn(this,options)

    // Remove the last prefix
    this._prefix = this._prefix.slice(0,-(prefix.length))

  } // end register

} // end API class

// Export the API class
module.exports = opts => new API(opts)
