/**
 *  
 */
var states = {
	DISCONNECTED: 1,
	CONNECTED: 2,
	AUTHORIZED: 3
};


/**
 * Real time high level library for Syncano (www.syncano.com)
 *
 * @class Syncano
 * @constructor
 */
var Syncano = function(){
	this.socketURL = 'https://api.syncano.com/ws';
	this.socket = null;
	this.status = states.DISCONNECTED;
	this.requestId = 1;
	this.uuid = null;
	
	this.VERSION = '3.1.0beta';
	
	/**
	 *  queue for messages which could not be sent because of no connection 
	 */
	this.requestsQueue = [];
	
	/**
	 *  in this list we will keep arrays of [action, callback] for every sent message, so we will be able to run callback function
	 *  when answer to message arrives. The list is indexed with message_id attribute
	 */
	this.waitingForResponse = {};
	
	/**
	 *  High-level function mixins
	 */
	this.Project = Project;
	this.Project.__super__ = this;
	this.Collection = Collection;
	this.Collection.__super__ = this;
	this.Folder = Folder;
	this.Folder.__super__ = this;
	this.Data = Data;
	this.Data.__super__ = this;
	this.User = User;
	this.User.__super__ = this;
	this.Subscription = Subscription;
	this.Subscription.__super__ = this;
	this.Connection = Connection;
	this.Connection.__super__ = this;
	this.Notification = Notification;
	this.Notification.__super__ = this;
};


/**
 *  add PubSub mixin
 */
Syncano.prototype = extend(Syncano.prototype, PubSub);


/**
 *  Establishes connecion to the server and sends authorization request.
 *  
 *  @method connect
 *  @param {object} params Connection parameters {instance, api_key, optional timezone}. If any of them is not defined, error is thrown
 *  @param {function} callback Optional callback to be called after successful connection and authorization.
 */
Syncano.prototype.connect = function(params, callback){
	if(typeof params === 'undefined' || typeof params.api_key === 'undefined' || typeof params.instance === 'undefined'){
		throw new Error('syncano.connect requires instance name and api_key');
	}
	if(typeof root.SockJS === 'undefined'){
		throw new Error('SockJS is required');
	}
	this.connectionParams = params;
	if(this.status != states.DISCONNECTED){
		this.reconnectOnSocketClose = true;
		return;
	}

	if(typeof callback === 'function'){
		this.waitingForResponse.auth = ['auth', callback];
	}

	this.socket = new root.SockJS(this.socketURL);
	this.socket.onopen = this.onSocketOpen.bind(this);
	this.socket.onclose = this.onSocketClose.bind(this);
	this.socket.onmessage = this.onMessage.bind(this);
};


/**
 *  Internal method called after the socket is open. Sends authorization request - instance, api_key and (optional) timezone 
 *  defined in this.connectionParams.
 *
 *  @method onSocketOpen
 */
Syncano.prototype.onSocketOpen = function(){
	this.status = states.CONNECTED;
	this.socketSend(this.connectionParams);
};


/**
 *  Internal method called automatically when socket is closed. Clears SockJS instance, changes state to DISCONNECTED. If there was
 *  waiting request to reconnect, handles reconnection with the same params.
 *
 *  @method onSocketClose
 */
Syncano.prototype.onSocketClose = function(){
	this.status = states.DISCONNECTED;
	this.socket = null;
	if(this.reconnectOnSocketClose === true){
		this.reconnectOnSocketClose = false;
		this.connect(this.connectionParams);
	}
};


/**
 *  Method called every time the message is received. Message is passed as e.data
 *  If there was an error, e.data.result is 'NOK' (not ok), otherwise e.data has response data.
 * 
 *  @method onMessage
 *  @param {object} e event object
 */
/** 
 *  When server cannot process request (result == NOK)
 *  @event syncano:error
 */
/** 
 *  When authorization failed
 *  @event syncano:auth:error
 */
/** 
 *  When response to message sent comes
 *  @event syncano:received
 */
Syncano.prototype.onMessage = function(e){
	var data = JSON.parse(e.data);
	
	if(data.result === 'NOK'){
		this.trigger('syncano:error', data.error || data.data.error);
		if(data.type === 'auth'){
			this.socket.close();
			this.trigger('syncano:auth:error');
		}
		return;
	} else {
		this.trigger('syncano:received', data);
	}
	
	switch(data.type){
		case 'auth':
			this.parseAuthorizationResponse(data);
			break;
			
		case 'callresponse':
			this.parseCallResponse(data);
			break;
			
		case 'message':
			this.parseMessageNotifier(data);
			break;
			
		case 'new':
			this.parseNewRecordNotifier(data);
			break;
			
		case 'change':
			this.parseChangeRecordNotifier(data);
			break;
			
		case 'delete':
			this.parseDeleteRecordNotifier(data);
			break;
	}
};


/**
 *  After successful authorization trigger event and send all queued messages
 *
 *  @method parseAuthorizationResponse
 *  @param {object} data Object send by server. Fields: timestamp, uuid, type, result
 */
/** 
 *  @event syncano:authorized
 */
Syncano.prototype.parseAuthorizationResponse = function(data){
	this.uuid = data.uuid;
	this.status = states.AUTHORIZED;
	this.trigger('syncano:authorized', this.uuid);
	this.parseCallResponse({message_id: 'auth', data:data});
	this.sendQueue();
};


/**
 *  When message with type 'new' comes, we trigger 3 events: one for the project (syncano:newdata:project-ID), 
 *  one for the collection (syncano:newdata:collection-ID) and one for the folder (syncano:newdata:folder-NAME).
 *  You can handle any of them.
 *  
 *  @method parseNewRecordNotifier
 *  @param {object} rec Object send by server. Fields: timestamp, uuid, type, result
 */
/**
 *  Triggered after receiving message with new record in folder XXX
 *  @event syncano:newdata:folder-XXX
 */
/** 
 *  Triggered after receiving message with new record in project XXX
 *  @event syncano:newdata:project-XXX
 */
/** 
 *  Triggered after receiving message with new record in collection XXX 
 *  @event syncano:newdata:collection-XXX
 */
Syncano.prototype.parseNewRecordNotifier = function(rec){
	var projectId = rec.channel.project_id | 0;
	var collectionId = rec.channel.collection_id | 0;
	var recData = rec.data;
	var folder = recData.folder;
	if(folder){
		this.trigger('syncano:newdata:folder-' + folder, recData);
	}
	this.trigger('syncano:newdata:project-' + projectId, recData);
	this.trigger('syncano:newdata:collection-' + collectionId, recData);
};


/**
 *  When message with type 'change' comes, trigger appropriate event for each data object modified.
 *
 *  @method parseChangeRecordNotifier
 *  @param {object} rec Object send by server. Fields: timestamp, uuid, type, result
 */
/** 
 *  Triggered after receiving message with changed record XXX 
 *  @event syncano:change:data-XXX
 */
Syncano.prototype.parseChangeRecordNotifier = function(rec){
	var targetIds = rec.target.id;
	for(var i=0; i<targetIds.length; i++){
		var id = targetIds[i];
		var p = {};
		if(typeof rec.add !== 'undefined'){
			p.add = rec.add;
		}
		if(typeof rec.replace !== 'undefined'){
			p.replace = rec.replace;
		}
		if(typeof rec.delete !== 'undefined'){
			p['delete'] = rec['delete'];
		}
		this.trigger('syncano:change:data-'+id, p);
	}
};

/**
 *  When message with type 'delete' comes, trigger appropriate event for each data object modified.
 *
 *  @method parseChangeRecordNotifier
 *  @param {object} rec Object send by server. Fields: timestamp, uuid, type, result
 */
/** 
 *  Triggered after receiving message with deleted record XXX 
 *  @event syncano:delete:data-XXX
 */
Syncano.prototype.parseDeleteRecordNotifier = function(rec){
	var targetIds = rec.target.id;
	for(var i=0; i<targetIds.length; i++){
		var id = targetIds[i];
		this.trigger('syncano:delete:data-'+id);
	}
};

/**
 *  When message with type 'message' comes, just trigger event with data passed
 *
 *  @method parseMessageNotifier
 *  @param {object} data Object send by server. Fields: timestamp, uuid, type, result
 */
/** 
 *  Triggered after receiving message from server
 *  @event syncano:message
 */
Syncano.prototype.parseMessageNotifier = function(data){
	this.trigger('syncano:message', data);
};


/**
 *  Receiven new callresponse message. If we were waiting for this response, handle it (call callback, etc). Otherwise - ignore
 *
 *  @method parseCallResponse
 *  @param {object} data - data received. Fields: type (=callresponse), message_id, result, data
 */
/** 
 *  When server sends data we are not waiting for
 *  @event syncano:ignored
 */
Syncano.prototype.parseCallResponse = function(data){
	var messageId = data.message_id;
	if(typeof messageId !== 'undefined' && typeof this.waitingForResponse[messageId] !== 'undefined'){
		var rec = this.waitingForResponse[messageId];
		var actionType = rec[0].replace('.', ':');
		var callback = rec[1];
		this.trigger('syncano:' + actionType, data.data);
		if(typeof callback === 'function'){
			callback(data.data);
		}
		delete this.waitingForResponse[messageId];
	} else {
		this.trigger('syncano:ignored', data);
	}
};


/**
 *  Sends all requests waiting in the queue and clears the queue.
 *
 *  @method sendQueue
 */
Syncano.prototype.sendQueue = function(){
	while(this.requestsQueue.length > 0){
		var request = this.requestsQueue.shift();
		this.socketSend(request);
	}
};


/**
 *  Generates unique message id
 * 
 *  @method getNextRequestId
 *  @return {number} next unique identifier
 */
Syncano.prototype.getNextRequestId = function(){
	return this.requestId++;
};


/**
 *  Sends request as a string. Internal low-level function, should not be used outside
 * 
 *  @method socketSend
 *  @param {object} request 
 */
Syncano.prototype.socketSend = function(request){
	this.socket.send(JSON.stringify(request) + "\n");
};


/**
 *  Universal high-level function for sending requests to syncano. 
 *  Sends request to 'method' with given 'params' if the socket is connected. If not, puts request on the queue to be sent later.
 *  Uses internal 'waitingForResponse' object to match request with response.
 *
 *  @method sendRequest
 *  @param {string} method Name of the Syncano method to call (check syncano docs)
 *  @param {object} params Parameters to send. Every method needs different parameters (check syncano docs)
 *  @param {function} callback Function to call after receiving response from server
 */
/** 
 *  Before sending request to server
 *  @event syncano:call
 */
/** 
 *  When user wants to send data to the server, but connection has not been established yet
 *  @event syncano:queued
 */
Syncano.prototype.sendRequest = function(method, params, callback){
	if(typeof params === 'undefined'){
		params = {};
	}
	
	var request = {
		type: 'call',
		method: method,
		params: params
	};
	
	request.message_id = this.getNextRequestId();

	/**
	 *  Remember method and callback on the waitingForResponse list. When the response comes, callback will be called
	 */
	this.waitingForResponse[request.message_id] = [method, callback];
	
	/**
	 *  Send message to socket if already open and authorized. Otherwise - push to requestsQueue
	 */
	if(this.status == states.AUTHORIZED){
		this.trigger('syncano:call', request);
		this.socketSend(request);
	} else {
		this.trigger('syncano:queued', request);
		this.requestsQueue.push(request);
	}
};

/**
 *  Internal method to check if projectId is a number - so I don't have to write this manualy again and again
 */
Syncano.prototype.__checkProjectId = function(projectId){
	if(typeof projectId !== 'number'){
		throw new Error('projectId must be a number');
	}
};

/**
 *  Internal method to check the variable name (string or number) and add correct key to passed object
 */
Syncano.prototype.__addCollectionIdentifier = function(params, collection){
	if (typeof collection === 'number'){
		params.collection_id = collection;
	} else if(typeof collection === 'string'){
		params.collection_key = collection;
	} else {
		throw new Error('Collection key/id must be passed');
	}
	return params;
};

/**
 *  Internal shortcut method to send request and run the callback function with proper data as parameter
 */
Syncano.prototype.__sendWithCallback = function(method, params, key, callback){
	this.sendRequest(method, params, function(data){
		var res;
		if(key === null){
			res = true;
		} else {
			res = data[key];
		}
		if(typeof callback === 'function'){
			callback(res);
		}
	});
};

var instance = null;


/**
 * Export to the root, which is probably `window`. 
 */
root.SyncanoConnector = {
	getInstance: function(){
		if(instance === null){
			instance = new Syncano();
		}
		return instance;
	}
};
