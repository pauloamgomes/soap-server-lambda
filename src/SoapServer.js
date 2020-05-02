"use strict";

const fs = require("fs");
const path = require("path");
const parser = require("fast-xml-parser");
const log = require("lambda-log");

const SoapRequestHandler = require("./SoapRequestHandler.js");
const SoapResposeHandler = require("./SoapResponseBodyHandler.js");
const SoapError = require("./SoapError.js");

/**
 * Soap Server
 */
class SoapServer {
  /**
   * A constructor
   *
   * @param {Object} config the configuration object for soap server
   */
  constructor(config) {
    this.services = {};
    this.handlers = {};

    const requestOptions =
      (config.options && config.options.requestParserOptions) || {};
    const responseOptions =
      (config.options && config.options.responseParserOptions) || {};

    this.eventParser = config.options && config.options.eventParser;
    this.authorize = config.options && config.options.authorize;
    this.handlers.request = new SoapRequestHandler(requestOptions);
    this.handlers.response = new SoapResposeHandler(responseOptions);

    if (config.services && typeof config.services === "function") {
      Object.assign(this.services, config.services());
      for (const service in this.services) {
        if (Object.prototype.hasOwnProperty.call(this.services, service)) {
          try {
            this.services[service].wsdl = this.services[service].wsdlPath
              ? fs
                  .readFileSync(
                    path.resolve(this.services[service].wsdlPath),
                    "utf-8"
                  )
                  .toString()
              : this.services[service].wsdlContents;
          } catch (error) {
            throw new Error(
              "Cannot read the wsdl file: " + this.services[service].wsdlPath
            );
          }
          if (parser.validate(this.services[service].wsdl) !== true) {
            throw new Error(
              "Cannot parse the wsdl file correctly: " +
                this.services[service].wsdlPath
            );
          }
        }
      }
    }
  }

  /**
   * Create the lambda handler
   *
   * @param {Object} options options object to create a lambda handler
   * @return {function} a lambda handler to handle the incoming event
   */
  createHandler(options) {
    // configure the server options
    if (options) {
      log.options.debug = options.debug ? true : false;
    }
    return async (evt, context) => {
      log.debug("Received an event", evt);
      // Custom parsing of event object
      const event =
        typeof this.eventParser === "function" ? this.eventParser(evt) : evt;
      // Check for custom authorization
      if (typeof this.authorize === "function" && !this.authorize(event)) {
        return {
          body: await this.handlers.response.fault(
            new SoapError(403, "Access Forbidden")
          ),
          statusCode: 403,
          headers: {
            "Content-Type": "application/xml",
          },
        };
      }
      // check this service exists
      const serviceName = event.path.replace(/\/$/, "").split("/").pop();
      // Par queryParams
      const queryParams = {};
      Object.keys(event.queryStringParameters).forEach((key) => {
        queryParams[key] = event.queryStringParameters[key];
      });

      if (this.services.hasOwnProperty(serviceName)) {
        log.info("Received a request for service", {
          service: serviceName,
        });
        // get calls
        if (event.httpMethod === "GET" && queryParams.hasOwnProperty("wsdl")) {
          log.info("Received a request for wsdl", {
            service: serviceName,
          });
          log.debug("The wsdl is: ", this.services[serviceName].wsdl);
          // return the wsdl
          return {
            body: this.services[serviceName].wsdl,
            statusCode: 200,
            headers: {
              "Content-Type": "application/xml",
            },
          };
        } else if (event.httpMethod === "POST") {
          // all post calls to service methods
          let requestOperation;
          try {
            requestOperation = await this.handlers.request.getOperation(
              event.body
            );
            log.debug(
              "Received a request for an operation: ",
              requestOperation
            );
          } catch (error) {
            log.error(error);
            return {
              body: await this.handlers.response.fault(error),
              statusCode: error.status ? error.status : 500,
              headers: {
                "Content-Type": "application/xml",
              },
            };
          }
          // get the implementation from the service
          const serviceimpl = this.services[serviceName].service;
          // invoke the method with argument
          let response;
          try {
            // get the input params
            let params;

            if (requestOperation.inputs) {
              params = requestOperation.inputs.map((input) => input.value);
            }

            if (serviceimpl[requestOperation.operation]) {
              response = await serviceimpl[requestOperation.operation].apply(
                null,
                params
              );
              log.debug("The response received from server", response);
            } else {
              throw new SoapError(501, "Operation didn't implemented");
            }
            const responseBody = await this.handlers.response.success(response);
            log.debug("Sending the reponse body as: ", responseBody);
            return {
              body: responseBody,
              statusCode: 200,
              headers: {
                "Content-Type": "application/xml",
              },
            };
          } catch (error) {
            log.error(error);
            return {
              body: await this.handlers.response.fault(error),
              statusCode: error.status ? error.status : 500,
              headers: {
                "Content-Type": "application/xml",
              },
            };
          }
        }
      } else {
        log.error("The service not found");
        log.debug("Available services are:", this.services);
        return {
          body: await this.handlers.response.fault(
            new SoapError(404, "Service not found")
          ),
          statusCode: 404,
          headers: {
            "Content-Type": "application/xml",
          },
        };
      }
    };
  }
}

module.exports = SoapServer;
