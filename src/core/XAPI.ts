import Stream from './Stream/Stream';
import Socket from './Socket/Socket';
import {Listener} from '../modules/Listener';
import Logger from '../utils/Logger';
import {Logger4Interface, EmptyLogger} from 'logger4';

export const DefaultHostname = 'ws.xtb.com';
export const DefaultRateLimit = 850;

export interface XAPIConfig {
	accountId: string,
	password: string,
	type: string,
	appName ?: string,
	host ?: string | undefined,
	rateLimit ?: number | undefined,
	logger ?: Logger4Interface
	safe ?: boolean
}

export interface XAPIAccount {
	accountId: string,
	type: string,
	appName ?: string | undefined,
	host: string,
	safe: boolean
}

export class XAPI extends Listener {
	public Stream: Stream;
	public Socket: Socket;
	private _tryReconnect: boolean = false;
	public get tryReconnect() { return this._tryReconnect; }
	private _rateLimit: number = DefaultRateLimit;
	public get rateLimit() { return this._rateLimit; }
	private timer: { interval: NodeJS.Timeout[], timeout: NodeJS.Timeout[] } = {
		interval: [],
		timeout: []
	};
	protected account: XAPIAccount = {
		type: 'demo',
		accountId: '',
		host: '',
		appName: undefined,
		safe: false
	};

	constructor({
		accountId, password, type, appName = undefined,
		host, rateLimit, logger = new EmptyLogger(), safe
	}: XAPIConfig) {
		super();
		Logger.setLogger(logger);
		this._rateLimit = rateLimit === undefined ? DefaultRateLimit : rateLimit;
		this.Socket = new Socket(this, password);
		this.Stream = new Stream(this);
		this.account = {
			type: (type.toLowerCase() === 'real') ? 'real' : 'demo',
			accountId,
			appName,
			host: host === undefined ? DefaultHostname : host,
			safe: safe === undefined ? false : safe
		};
		if (this.account.safe) {
			Logger.log.warn('[TRADING DISABLED] tradeTransaction command is disabled, this mean you can\'t open, modify or close positions.');
		}
		this.Stream.onConnectionChange(status => {
			if (this.Socket.status) {
				this.callListener('xapiConnectionChange', [status]);
			}
		});
		this.Socket.onConnectionChange(status => {
			if (this.Stream.status) {
				this.callListener('xapiConnectionChange', [status]);
			}

			if (!status) {
				this.Stream.session = '';
				this.stopTimer();
			}
		});

		this.Socket.listen.login((data, time, transaction) => {
			this.session = data.streamSessionId;
		});

		this.addListener('xapiReady', () => {
			this.stopTimer();

			this.timer.interval.push(setInterval(() => {
				if (this.Socket.status) {
					this.Socket.ping();
				}
				if (this.Stream.status) {
					this.Stream.ping();
				}
				this.timer.timeout.push(setTimeout(() => {
					if (this.Socket.status) {
						this.Socket.send.getServerTime();
					}
				}, 1000));
				this.timer.timeout.push(setTimeout(() => {
					if (this.Socket.status) {
						this.Socket.send.getTrades();
					}
				}, 2000));

				this.Socket.rejectOldTransactions();
				this.Stream.rejectOldTransactions();
				if (Object.keys(this.Socket.transactions).length > 20000) {
					this.Socket.removeOldTransactions();
				}
				if (Object.keys(this.Stream.transactions).length > 20000) {
					this.Stream.removeOldTransactions();
				}
			}, 19000));
		}, 'constructor');
	}

	private stopTimer() {
		this.timer.interval.forEach(i => clearInterval(i));
		this.timer.timeout.forEach(i => clearTimeout(i));
		this.timer = { interval: [], timeout: [] };
	}

	public get accountType(): string | null {
		return this.account.type;
	}

	public get isTradingDisabled(): boolean {
		return this.account.safe;
	}

	public get accountId(): string {
		return this.account.accountId;
	}

	public get appName(): string | undefined {
		return this.account.appName;
	}

	public get hostName(): string {
		return this.account.host;
	}

	public set session(session: string) {
		this.Stream.session = session;
		if (this.Stream.status && session !== null && session.length > 0) {
			this.Stream.ping();
			this.callListener('xapiReady');
		}
	}

	public connect() {
		this._tryReconnect = true;
		this.Stream.connect();
		this.Socket.connect();
	}

	public get isConnectionReady() {
		return this.Stream.status && this.Socket.status;
	}

	public disconnect() {
		return new Promise((resolve, reject) => {
			this.Stream.session = '';
			this._tryReconnect = false;
			this.Stream.closeConnection();
			if (this.Socket.status) {
				this.Socket.logout()
					.catch(() => {})
					.then(() => {
						this.Socket.closeConnection();
						resolve();
					});
			} else {
				this.Socket.closeConnection();
				resolve();
			}
		});
	}

	public onReady(callBack: () => void, key: string = 'default') {
		if (this.Stream.session.length > 0 && this.isConnectionReady) {
			callBack();
		}
		this.addListener('xapiReady', callBack, key);
	}

	public onConnectionChange(callBack: (status: boolean) => void, key: string | null = null) {
		this.addListener('xapiConnectionChange', callBack, key);
	}

}

export default XAPI;
