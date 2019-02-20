const {
    SuccessResult,
    FailureResult,
    Logger,
    LOGGER_CONSTANTS,
    utils,
    requestValidator
} = require('../../common');

const {
    HTTP_RESPONSES,
    ERROR_CODES,
    API_TIMEOUT
} = require('../../constants/apiConstants');

const logger = Logger(LOGGER_CONSTANTS.SERVER);

class SuccessAPIResult extends SuccessResult {
    constructor(message, messageCode, data, meta, code, link) {
        super(data, meta, code);
        this.message = message;
        this.messageCode = messageCode;
        this.link = link;
    }
}
class FailureAPIResult extends FailureResult {
    constructor(message, messageCode, error, meta, code, link) {
        super(error, meta, code);
        this.message = message;
        this.link = link;
        this.messageCode = messageCode || ERROR_CODES.INTERNAL_SERVER_ERROR;
    }
}

const closureOfApiRoute = (routeConfig, controllerFn, eventEmittor) => async function commonApiHandler(req, res) {
    const context = {
        transactionID: req.header('transactionID') || utils.uuidv4(),
        authToken: req.header('Authorization'),
        username: req.header('userId')
    };

    if (!context.authToken || !context.authToken) {
        return res
            .status(HTTP_RESPONSES.AUTHENTICATION_FAILED.code)
            .send(new FailureAPIResult('Your are not authorized to perform this action!', ERROR_CODES.AUTHORIZATION_FAILED));
    }


    const x = new Date();
    const offset = Math.abs(x.getTimezoneOffset());
    /* eslint radix:0 */
    res.header('timezone-offset', `${(offset >= 0 ? '+' : '-') + parseInt(offset / 60)}:${offset % 60}`);
    res.header('timezone', `${Intl.DateTimeFormat().resolvedOptions().timeZone}`);


    if (!context.authToken || !context.authToken) {
        return res
            .status(HTTP_RESPONSES.AUTHORIZATION_FAILED.code)
            .send(new FailureAPIResult('Your are not authorized to perform this action!', ERROR_CODES.AUTHORIZATION_FAILED));
    }

    let controller;
    if (typeof controllerFn === 'function') {
        controller = controllerFn(context, eventEmittor);
    }

    // Check if request inputs are valid
    if (!requestValidator.validateRequest(routeConfig, req.body, req.query, req.params)) {
        const errors = [];
        // To send the validation errors of various inputs looping throug error objects
        Object.keys(routeConfig.validators).forEach((key) => {
            if (routeConfig.validators[key].error) {
                const error = routeConfig.validators[key].error;
                errors.push(error);
            }
        });
        return res.status(HTTP_RESPONSES.REQUEST_VALIDATION_FAILED.code)
            .send(new FailureAPIResult(`Request validation failed! \n${errors.join('\n')}`, ERROR_CODES.REQUEST_VALIDATION_FAILED, errors.join('\n')));
    }

    requestValidator.filterRequest(routeConfig, req);
    try {
        // Call the api handler configured
        routeConfig.apiHandler(controller, context, eventEmittor)(req, (err, reason, meta, code) => {
            if (typeof meta !== 'undefined') {
                Object.keys(meta).forEach((key) => {
                    res.header(key, meta[key]);
                });
            }
            if (err) {
                if (err === 'access_denied' || err.status === 401) {
                    return res
                        .status(code || HTTP_RESPONSES.AUTHORIZATION_FAILED.code)
                        .send(new FailureAPIResult(err.message || 'External interface access denied', ERROR_CODES.AUTHORIZATION_FAILED, err));
                }
                // Other errors are considered as Internal server error
                const errMessage = typeof err === 'object' ? (err.message || 'Operation failed!') : err;
                const errorCode = typeof err === 'object' ? (err.messageCode || ERROR_CODES.OPERATION_FAILED) : ERROR_CODES.OPERATION_FAILED;

                return res
                    .status(code || err.statusCode || HTTP_RESPONSES.BUSINESS_SERVICES_DOWN.code)
                    .send(new FailureAPIResult(errMessage, errorCode, reason || err.error));
            }
            if (reason.data && reason.data.task) {
                /* eslint no-param-reassign:0 */
                reason.data.task.event = undefined;
            }
            return res
                .status(code || HTTP_RESPONSES.SUCCESS.code)
                .send(new SuccessAPIResult(reason.message, reason.messageCode, reason.data));
        });
    } catch (e) {
        logger.error(e);
        return res
            .status(HTTP_RESPONSES.INTERNAL_SERVER_ERROR.code)
            .send(new FailureAPIResult(e.message, ERROR_CODES.INTERNAL_SERVER_ERROR));
    }
    return null;
};


//* * */
// Common error handler
//* * */
function globalRouteErrorHandler(err, req, res, next) {
    logger.error(err.stack);
    res
        .status(err.status || HTTP_RESPONSES.INTERNAL_SERVER_ERROR.code)
        .send(new FailureAPIResult(err.message || 'Something broke!', ERROR_CODES.INTERNAL_SERVER_ERROR, err));
    return next;
}

//* * */
// Not found error handler
//* * */
function routeNotFoundHandler(req, res) {
    res.status(HTTP_RESPONSES.NOT_FOUND.code)
        .send(new FailureAPIResult("Sorry can't find that!", ERROR_CODES.NOT_FOUND));
}
/**
 * @desc Takes care of injecting configure controller to apiHandler  of that route
 *
 * @class ControllerInjector
 */
class ControllerInjector {
    constructor(controllers) {
        this.controllers = controllers;
    }
    getController(routeConfig) {
        let controllerFn = this.controllers;
        if (typeof routeConfig.controller === 'string') {
            const controllerPath = routeConfig.controller.split('.');
            controllerPath.shift();
            while (controllerPath.length > 0) {
                if (typeof controllerFn !== 'undefined') {
                    controllerFn = controllerFn[controllerPath.shift()];
                } else {
                    logger.error('Invalid configuration of controller!', routeConfig);
                    break;
                }
            }
        }
        return controllerFn;
    }
}


module.exports = (Router, eventEmittor) =>
    ({
        registerRoutes: (rootApp, handlers, controllers) => {
            //* * */
            // Registering exception handler route
            //* * */
            rootApp.use(globalRouteErrorHandler);
            const controllerInjector = new ControllerInjector(controllers);
            //* * */
            // common route entry
            //* * */
            /** @var {WrapperModule} mainApi */
            const mainApi = Router();
            rootApp.use('/trade-mgmt-api', mainApi);
            mainApi.use((req, res, next) => {
                const requestLogger = Logger(LOGGER_CONSTANTS.SERVER, req.header('transactionId'));
                requestLogger.debug('route entry!', req.method, req.url);
                const send = res.send;
                /* eslint consistent-return:0 */
                res.send = function newSend(...args) {
                    if (typeof args[0] === 'string') {
                        requestLogger.debug('route exit!', this.req.method, this.req.url);
                    }

                    if (!req.timedout || req.timeoutID) {
                        clearTimeout(req.timeoutID);
                        return send.apply(res, args);
                    }
                };
                req.timeoutID = setTimeout(() => {
                    req.timedout = true;
                    res
                        .status(HTTP_RESPONSES.REQUEST_TIMEDOUT.code)
                        .send(new FailureAPIResult('Request timedout!', ERROR_CODES.REQUEST_TIMEDOUT, 'The operation requested takes too long to process!'));
                    clearTimeout(req.timeoutID);
                    req.timeoutID = 0;
                }, API_TIMEOUT);
                next();
            });
            //
            // Loop through handlers and register routes
            Object.keys(handlers).forEach((route) => {
                const subModuleRoute = Router();
                mainApi.use(`/${route}`, subModuleRoute);
                const handlerConfig = handlers[route];
                handlerConfig.routes.forEach((routeConfig) => {
                    if (typeof routeConfig.apiHandler === 'function') {
                        logger.debug('registering api route ', routeConfig, route);
                        requestValidator.loadValidators(routeConfig);
                        requestValidator.loadFilters(routeConfig);
                        subModuleRoute[routeConfig.method](routeConfig.path, closureOfApiRoute(routeConfig, controllerInjector.getController(routeConfig), eventEmittor));
                    } else {
                        logger.error('Invalid configuration!', route, routeConfig);
                    }
                });
            });
            //* * */
            // Registering route not found handler
            //* * */
            rootApp.use(routeNotFoundHandler);
        }
    });