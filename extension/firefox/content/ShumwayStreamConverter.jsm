/*
 * Copyright 2015 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var EXPORTED_SYMBOLS = ['ShumwayStreamConverter', 'ShumwayStreamOverlayConverter'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const SHUMWAY_CONTENT_TYPE = 'application/x-shockwave-flash';
const EXPECTED_PLAYPREVIEW_URI_PREFIX = 'data:application/x-moz-playpreview;,' +
                                        SHUMWAY_CONTENT_TYPE;

const FIREFOX_ID = '{ec8030f7-c20a-464f-9b0e-13a3a9e97384}';
const SEAMONKEY_ID = '{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}';

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/Services.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'PrivateBrowsingUtils',
  'resource://gre/modules/PrivateBrowsingUtils.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'ShumwayTelemetry',
  'resource://shumway/ShumwayTelemetry.jsm');

Components.utils.import('chrome://shumway/content/StartupInfo.jsm');

function getBoolPref(pref, def) {
  try {
    return Services.prefs.getBoolPref(pref);
  } catch (ex) {
    return def;
  }
}

function log(aMsg) {
  let msg = 'ShumwayStreamConverter.js: ' + (aMsg.join ? aMsg.join('') : aMsg);
  Services.console.logStringMessage(msg);
  dump(msg + '\n');
}

function getDOMWindow(aChannel) {
  var requestor = aChannel.notificationCallbacks ||
                  aChannel.loadGroup.notificationCallbacks;
  var win = requestor.getInterface(Components.interfaces.nsIDOMWindow);
  return win;
}

function activateShumwayScripts(window) {
  function initScripts() {
    window.wrappedJSObject.runViewer();

    var parentWindow = window.parent;
    var viewerWindow = window.viewer.contentWindow;

    function activate(e) {
      e.preventDefault();
      viewerWindow.removeEventListener('mousedown', activate, true);

      parentWindow.addEventListener('keydown', forwardKeyEvent, true);
      parentWindow.addEventListener('keyup', forwardKeyEvent, true);

      sendFocusEvent('focus');

      parentWindow.addEventListener('blur', deactivate, true);
      parentWindow.addEventListener('mousedown', deactivate, true);
      viewerWindow.addEventListener('unload', deactivate, true);
    }

    function deactivate() {
      parentWindow.removeEventListener('blur', deactivate, true);
      parentWindow.removeEventListener('mousedown', deactivate, true);
      viewerWindow.removeEventListener('unload', deactivate, true);

      parentWindow.removeEventListener('keydown', forwardKeyEvent, true);
      parentWindow.removeEventListener('keyup', forwardKeyEvent, true);

      sendFocusEvent('blur');

      viewerWindow.addEventListener('mousedown', activate, true);
    }

    function forwardKeyEvent(e) {
      var event = viewerWindow.document.createEvent('KeyboardEvent');
      event.initKeyEvent(e.type,
                         e.bubbles,
                         e.cancelable,
                         e.view,
                         e.ctrlKey,
                         e.altKey,
                         e.shiftKey,
                         e.metaKey,
                         e.keyCode,
                         e.charCode);
      viewerWindow.dispatchEvent(event);
    }

    function sendFocusEvent(type) {
      var event = viewerWindow.document.createEvent("UIEvent");
      event.initEvent(type, false, true);
      viewerWindow.dispatchEvent(event);
    }

    if (viewerWindow) {
      viewerWindow.addEventListener('mousedown', activate, true);
    }

    window.addEventListener('shumwayFallback', function (e) {
      var automatic = !!e.detail.automatic;
      fallbackToNativePlugin(window, !automatic, automatic);
    });
  }

  if (window.document.readyState === "interactive" ||
      window.document.readyState === "complete") {
    initScripts();
  } else {
    window.document.addEventListener('DOMContentLoaded', initScripts);
  }
}

function ShumwayStreamConverter() {
}

ShumwayStreamConverter.prototype = {
  classID: Components.ID('{4c6030f7-e20a-264f-5b0e-ada3a9e97384}'),
  classDescription: 'Shumway Content Converter Component',
  contractID: '@mozilla.org/streamconv;1?from=application/x-shockwave-flash&to=*/*',

  classID2: Components.ID('{4c6030f8-e20a-264f-5b0e-ada3a9e97384}'),
  contractID2: '@mozilla.org/streamconv;1?from=application/x-shockwave-flash&to=text/html',

  QueryInterface: XPCOMUtils.generateQI([
      Ci.nsISupports,
      Ci.nsIStreamConverter,
      Ci.nsIStreamListener,
      Ci.nsIRequestObserver
  ]),

  /*
   * This component works as such:
   * 1. asyncConvertData stores the listener
   * 2. onStartRequest creates a new channel, streams the viewer and cancels
   *    the request so Shumway can do the request
   * Since the request is cancelled onDataAvailable should not be called. The
   * onStopRequest does nothing. The convert function just returns the stream,
   * it's just the synchronous version of asyncConvertData.
   */

  // nsIStreamConverter::convert
  convert: function(aFromStream, aFromType, aToType, aCtxt) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  getUrlHint: function(requestUrl) {
    return requestUrl.spec;
  },

  getStartupInfo: function(window, url) {
    var initStartTime = Date.now();
    var element = window.frameElement;
    if (element) {
      return getStartupInfo(element);
    }

    // Stream converter is used in top level window, just providing basic
    // information about SWF.

    var objectParams = {};
    var movieParams = {};
    var queryStringMatch = url && /\?([^#]+)/.exec(url);
    if (queryStringMatch) {
      var queryStringParams = parseQueryString(queryStringMatch[1]);
      for (var i in queryStringParams) {
        if (!(i in movieParams)) {
          movieParams[i] = queryStringParams[i];
        }
      }
    }

    // Using the same data structure as we return in StartupInfo.jsm and
    // assigning constant values for fields that is not applicable for
    // the stream converter when it is used in a top level window.
    var startupInfo = {};
    startupInfo.window = window;
    startupInfo.url = url;
    startupInfo.privateBrowsing = isContentWindowPrivate(window);
    startupInfo.objectParams = objectParams;
    startupInfo.movieParams = movieParams;
    startupInfo.baseUrl = url;
    startupInfo.isOverlay = false;
    startupInfo.refererUrl = null;
    startupInfo.embedTag = null;
    startupInfo.isPausedAtStart = /\bpaused=true$/.test(url);
    startupInfo.initStartTime = initStartTime;
    startupInfo.allowScriptAccess = true;
    return startupInfo;
  },

  // nsIStreamConverter::asyncConvertData
  asyncConvertData: function(aFromType, aToType, aListener, aCtxt) {
    // Store the listener passed to us
    this.listener = aListener;
  },

  // nsIStreamListener::onDataAvailable
  onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
    // Do nothing since all the data loading is handled by the viewer.
    log('SANITY CHECK: onDataAvailable SHOULD NOT BE CALLED!');
  },

  // nsIRequestObserver::onStartRequest
  onStartRequest: function(aRequest, aContext) {
    // Setup the request so we can use it below.
    aRequest.QueryInterface(Ci.nsIChannel);

    aRequest.QueryInterface(Ci.nsIWritablePropertyBag);

    // Change the content type so we don't get stuck in a loop.
    aRequest.setProperty('contentType', aRequest.contentType);
    aRequest.contentType = 'text/html';

    // TODO For now suspending request, however we can continue fetching data
    aRequest.suspend();

    var originalURI = aRequest.URI;

    // Create a new channel that loads the viewer as a chrome resource.
    var viewerUrl = 'chrome://shumway/content/viewer.wrapper.html';
    // TODO use only newChannel2 after FF37 is released.
    var channel = Services.io.newChannel2 ?
                  Services.io.newChannel2(viewerUrl,
                                          null,
                                          null,
                                          null, // aLoadingNode
                                          Services.scriptSecurityManager.getSystemPrincipal(),
                                          null, // aTriggeringPrincipal
                                          Ci.nsILoadInfo.SEC_NORMAL,
                                          Ci.nsIContentPolicy.TYPE_OTHER) :
                  Services.io.newChannel(viewerUrl, null, null);

    var converter = this;
    var listener = this.listener;
    // Proxy all the request observer calls, when it gets to onStopRequest
    // we can get the dom window.
    var proxy = {
      onStartRequest: function(request, context) {
        listener.onStartRequest(aRequest, context);
      },
      onDataAvailable: function(request, context, inputStream, offset, count) {
        listener.onDataAvailable(aRequest, context, inputStream, offset, count);
      },
      onStopRequest: function(request, context, statusCode) {
        // Cancel the request so the viewer can handle it.
        aRequest.resume();
        aRequest.cancel(Cr.NS_BINDING_ABORTED);

        var domWindow = getDOMWindow(channel);
        let startupInfo = converter.getStartupInfo(domWindow, converter.getUrlHint(originalURI));

        listener.onStopRequest(aRequest, context, statusCode);

        if (!startupInfo.url) {
          // Special case when movie URL is not specified, e.g. swfobject
          // checks only version. No need to instantiate the flash plugin.
          if (startupInfo.embedTag) {
            setupSimpleExternalInterface(startupInfo.embedTag);
          }
          return;
        }

        domWindow.shumwayStartupInfo = startupInfo;

        // TODO Report telemetry on amount of swfs on the page
        // ShumwayTelemetry.onPageIndex(pageIndex);

        activateShumwayScripts(domWindow);
      }
    };

    // Keep the URL the same so the browser sees it as the same.
    channel.originalURI = aRequest.URI;
    channel.loadGroup = aRequest.loadGroup;

    // We can use all powerful principal: we are opening chrome:// web page,
    // which will need lots of permission.
    var securityManager = Cc['@mozilla.org/scriptsecuritymanager;1']
                          .getService(Ci.nsIScriptSecurityManager);
    var resourcePrincipal = securityManager.getSystemPrincipal();
    aRequest.owner = resourcePrincipal;
    channel.asyncOpen(proxy, aContext);
  },

  // nsIRequestObserver::onStopRequest
  onStopRequest: function(aRequest, aContext, aStatusCode) {
    // Do nothing.
  }
};

function setupSimpleExternalInterface(embedTag) {
  Components.utils.exportFunction(function (variable) {
    switch (variable) {
      case '$version':
        return 'SHUMWAY 10,0,0';
      default:
        log('Unsupported GetVariable() call: ' + variable);
        return undefined;
    }
  }, embedTag.wrappedJSObject, {defineAs: 'GetVariable'});
}

// properties required for XPCOM registration:
function copyProperties(obj, template) {
  for (var prop in template) {
    obj[prop] = template[prop];
  }
}
