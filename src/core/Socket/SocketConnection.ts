import {TransactionResolveSocket} from "../../interface/Interface";
import XAPI from "../XAPI";
import {Time} from "../../modules/Time";
import {WebSocketWrapper} from "../../modules/WebSocketWrapper";
import Logger from "../../utils/Logger";
import {errorCode} from "../../enum/errorCode";
import {TransactionStatus, TransactionType} from "../../enum/Enum";
import {Queue} from "../Queue";
import Utils from "../../utils/Utils";

export class SocketConnection extends Queue {
	private XAPI: XAPI;
	private _password: string;

	constructor(XAPI: XAPI, password: string) {
		super(XAPI.rateLimit, TransactionType.SOCKET);
		this._password = password;
		this.XAPI = XAPI;
	}

	private handleData(returnData: any, customTag: string, time: Time) {
		const { transactionId, command } = Utils.parseCustomTag(customTag);

		if (transactionId !== null && command !== null && this.transactions[transactionId] !== undefined) {
			this.transactions[transactionId].response = {
				status: true,
				received: time,
				json: returnData
			};

			this.resolveTransaction(returnData, time, this.transactions[transactionId]);

			if (this.listeners[command] !== undefined) {
				this.callListener(command, [returnData, time, this.transactions[transactionId]]);
			}
		} else {
			Logger.log.error('Received a message without vaild customTag (customTag = ' + customTag + ')\n' + JSON.stringify(returnData, null, "\t"));
		}
	}

	public connect() {
		if (this.XAPI.tryReconnect === false) {
			Logger.log.hidden("Socket connect is called when tryReconnect is false", "WARN");
			return;
		}
		this.WebSocket = new WebSocketWrapper('wss://' + this.XAPI.hostName +'/' + this.XAPI.accountType);
		this.WebSocket.onOpen(() => {
			Logger.log.hidden("Socket open", "INFO");
			this.resetMessageTube();
			this.setConnection(true);
		});

		this.WebSocket.onClose(() => {
			if (this.status === true) {
				Logger.log.hidden("Socket closed", "INFO");
			}
			this.setConnection(false);
			this.resetMessageTube();
			if (this.XAPI.tryReconnect) {
				setTimeout(() => {
					if (this.XAPI.tryReconnect) {
						this.connect();
					}
				}, 2000);
			}
			for (const transactionId in this.transactions) {
				const isInterrupted = (this.transactions[transactionId].status === TransactionStatus.sent);
				if (this.transactions[transactionId].status === TransactionStatus.waiting || isInterrupted) {
					this.rejectTransaction({ code: errorCode.XAPINODE_1, explain: "Socket closed"}, this.transactions[transactionId], isInterrupted);
				}
			}
		});

		this.WebSocket.onMessage((message: any) => {
			try {
				const json = JSON.parse(message.toString().trim());
				this.handleSocketMessage(json, new Time());
			} catch (e) {
				const { name, message, stack } = new Error(e);
				Logger.log.error("Socket WebSocket Error");
				Logger.log.hidden(name + "\n" + message + (stack ? "\n" + stack : ""), "ERROR");
			}
		});

		this.WebSocket.onError((error: any) => {
			const { name, message, stack } = new Error(error);
			Logger.log.error("Socket WebSocket Error\n" + name + "\n" + message + (stack ? "\n" + stack : ""));
		});
	}

	public onConnectionChange(callBack: (status: boolean) => void, key: string | null = null) {
		this.addListener("connectionChange", callBack, key);
	}

	private setConnection(status: boolean) {
		if (this.status !== status) {
			this.status = status;
			this.callListener("connectionChange", [status]);
		}

		if (this.openTimeout !== null) {
			clearTimeout(this.openTimeout);
		}

		if (status) {
			this.ping();
			this.openTimeout = setTimeout(() => {
				this.openTimeout = null;
				if (this.status) {
					this.tryLogin(2);
				}
			}, 1000);
		}
	}

	private tryLogin(retries: number = 2) {
		this.XAPI.Socket.login().then(() => {
			Logger.log.hidden("Login is successful (userId = " + this.XAPI.accountId
				+ ", accountType = " + this.XAPI.accountType + ")", "INFO");
			this.ping();
		}).catch(e => {
			Logger.log.hidden("Login is rejected (userId = " + this.XAPI.accountId
				+ ", accountType = " + this.XAPI.accountType
				+ ")\nReason:\n" + JSON.stringify(e, null, "\t"), "ERROR");
			if (retries > 0 && e.reason.code !== errorCode.XAPINODE_1 && e.reason.code !== errorCode.BE005) {
				setTimeout(() => {
					Logger.log.hidden("Try to login (retries = " + retries + ")", "INFO");
					this.tryLogin(retries - 1);
				}, 500);
			} else if (e.reason.code === errorCode.BE005) {
				Logger.log.error("Disconnect from stream and socket (reason = 'login error code is " + e.reason.code + "')");
				this.XAPI.disconnect();
			}
		});
	}

	private handleError(code: any, explain: any, customTag: string | null, received: Time) {
		const { transactionId } = Utils.parseCustomTag(customTag);

		if (transactionId !== null && this.transactions[transactionId] !== undefined) {
			this.rejectTransaction({ code, explain }, this.transactions[transactionId], false, received);
		} else {
			Logger.log.hidden("Socket error message:\n"
				+ JSON.stringify({ code, explain, customTag }, null, "\t"), "ERROR");
		}
	}

	private handleSocketMessage(message: any, time: Time) {
		this.lastReceivedMessage.reset();
		if (message.status) {
			this.handleData(
				(message.streamSessionId !== undefined) ?
						{streamSessionId: message.streamSessionId} : message.returnData,
				typeof(message.customTag) === 'string' ?
						message.customTag : null,
				time);
		} else if (message.status !== undefined
			&& message.errorCode !== undefined) {
			const { errorCode } = message;
			const customTag: string | null = message.customTag !== undefined ? message.customTag : null;
			const errorDescr: string | null  = message.errorDescr !== undefined ? message.errorDescr : null;
			this.handleError(errorCode, errorDescr, customTag, time);
		}
	}

	protected sendCommand<T>(command: string, args: any = {}, transactionId: string | null = null, urgent: boolean = false):
		Promise<TransactionResolveSocket<T>> {
		return new Promise((resolve: any, reject: any) => {
			if (transactionId === null) {
				transactionId = this.createTransactionId();
			}
			const transaction = this.addTransaction({
				command,
				json: JSON.stringify({
					command,
					arguments: (Object.keys(args).length === 0) ? undefined : args,
					customTag: command + '_' + transactionId }),
				args,
				transactionId,
				urgent,
				resolve,
				reject
			});
			if (this.status === false) {
				this.rejectTransaction({
					code: errorCode.XAPINODE_1,
					explain: "Socket closed"
				}, this.transactions[transactionId]);
			} else if (this.XAPI.Stream.session.length === 0
				&& "login" !== command
				&& "ping" !== command
				&& "logout" !== command) {
				this.rejectTransaction({ code: errorCode.XAPINODE_BE103, explain: 'User is not logged' }, transaction);
			} else {
				this.sendJSON(transaction, true);
			}
		});
	}

	public closeConnection() {
		if (this.WebSocket !== null) {
			this.WebSocket.close();
		}
	}

	public ping() {
		return this.sendCommand<null>('ping', {}, null, true);
	}

	public logout() {
		return this.sendCommand<null>('logout', {}, null, true);
	}

	public login() {
		return this.sendCommand('login', {
			'userId': this.XAPI.accountId,
			'password': this._password,
			'appName': this.XAPI.appName
		}, null, true);
	}
}
