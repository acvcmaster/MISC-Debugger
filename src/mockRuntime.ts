import { EventEmitter } from 'events';
import { Socket } from 'net';
import fetch, { Headers } from 'node-fetch';
import { Observable, Subject } from 'rxjs';

export interface FileAccessor {
	readFile(path: string): Promise<string>;
}

export interface ProgramStartResponse {
	hasError: boolean;
	error?: string;
}

export interface RuntimeBreakpoint {
	verified: boolean;
	line: number;
	id: number;
}

export interface RuntimeStackframe {
	index: number;
	name: string;
	file: string;
	line: number;
}

export interface RuntimeStackframes {
	frames: RuntimeStackframe[];
	count: number;
}

export class RuntimeAdapter extends EventEmitter {
	constructor(private fileAccessor: FileAccessor) {
		super();
		this.clientSubject.subscribe(client => this.client = client);
	}

	sourcePath: string | undefined;
	sourceText: string | undefined;
	client: Socket | undefined;
	clientConnected = false;
	clientSubject = new Subject<Socket | undefined>();
	dataSubject = new Subject<any | undefined>();


	public start(path: string, stopAtEntry = false): Promise<any> {
		return new Promise(async (resolve, _) => {
			this.sourcePath = path;
			this.sourceText = await this.fileAccessor.readFile(this.sourcePath);

			const subscription = this.request('POST', 'Debug', 'Start', { stopAtEntry }).subscribe(data => {
				const event = data?.event || '';
				const error = data?.error;

				if (!error && event) {
					this.sendEvent(event);
				}

				resolve(data);
				subscription.unsubscribe();
			});
		});
	}

	private startClient() {
		// this.client = new Socket();
		// this.client.connect(55821, '127.0.0.1', () => {
		// 	this.client?.addListener('end', () => this.sendEvent('end'));
		// 	this.client?.addListener('data', data => {
		// 		const array = getJsonArray(data);
		// 		if (array) {
		// 			const objects = JSON.parse(array) || [];
		// 			for (const object of objects) {
		// 				this.dataSubject.next(object);
		// 			}
		// 		}
		// 	});
		// 	this.clientSubject.next(this.client);
		// });
	}

	public clearBreakpoints(): Promise<void> {
		return new Promise((resolve, _) => {
			// if (!this.client) {
			// 	this.startClient();
			// 	const subscription = this.clientSubject.subscribe(async client => {
			// 		client?.write(JSON.stringify({
			// 			debugCommand: 'clearBreakpoints'
			// 		}));

			// 		resolve();
			// 		subscription.unsubscribe();
			// 	});
			// } else {
			// 	this.client.write(JSON.stringify({
			// 		debugCommand: 'clearBreakpoints'
			// 	}));

			// 	resolve();
			// }
		});
	}

	public setBreakPoint(line: number): RuntimeBreakpoint | PromiseLike<RuntimeBreakpoint> {
		return new Promise((resolve, _) => {
			// const guid = v4();

			// this.client?.write(JSON.stringify({
			// 	debugCommand: 'setBreakpoint',
			// 	line,
			// 	guid
			// }));

			// const subscription = this.dataSubject.subscribe(data => {
			// 	if (data && data.guid === guid) {
			// 		console.log(data);
			// 		resolve(data);
			// 		subscription.unsubscribe();
			// 	}
			// });
		});
	}

	public step(): Promise<boolean> {
		return new Promise(async (resolve, _) => {
			// this.client?.write(JSON.stringify({
			// 	debugCommand: 'step'
			// }));

			// const subscription = this.dataSubject.subscribe(data => {
			// 	if (data && (data.debugCommand === 'stopOnStep' || data.debugCommand === 'end')) {
			// 		console.log(data.debugCommand);
			// 		this.sendEvent(data.debugCommand);
			// 		resolve(data.debugCommand === 'end');
			// 		subscription.unsubscribe();
			// 	}
			// });
		});
	}

	public getStackFrames(): Promise<RuntimeStackframes> {
		return new Promise(async (resolve, _) => {
			// const guid = v4();
			// this.client?.write(JSON.stringify({
			// 	debugCommand: 'getStackFrames',
			// 	guid
			// }));

			// const subscription = this.dataSubject.subscribe(data => {
			// 	if (data && data.guid === guid) {
			// 		const frames = (data.frames || []).map(item => ({ ...item, file: this.sourcePath || '' }));
			// 		subscription.unsubscribe();
			// 		resolve({ ...data, frames });
			// 	}
			// });
		});
	}

	public getBreakpoints(): Promise<{ line: number }[]> {
		return new Promise(async (resolve, _) => {
			// const guid = v4();
			// this.client?.write(JSON.stringify({
			// 	debugCommand: 'getBreakpoints',
			// 	guid
			// }));

			// const subscription = this.dataSubject.subscribe(data => {
			// 	if (data && data.guid === guid) {
			// 		subscription.unsubscribe();
			// 		resolve(data.lines);
			// 	}
			// });
		});
	}

	public continue(): Promise<void> {
		return new Promise(async (resolve, _) => {
			// const guid = v4();
			// this.client?.write(JSON.stringify({
			// 	debugCommand: 'continue',
			// 	guid
			// }));

			// const subscription = this.dataSubject.subscribe(data => {
			// 	if (data && data.guid === guid) {
			// 		subscription.unsubscribe();
			// 		resolve(data.debugCommand);
			// 	}
			// });
		});
	}

	getVariables(): Promise<any[]> {
		return new Promise(async (resolve, _) => {
			// const guid = v4();
			// this.client?.write(JSON.stringify({
			// 	debugCommand: 'getVariables',
			// 	guid
			// }));

			// const subscription = this.dataSubject.subscribe(data => {
			// 	if (data && data.guid === guid) {
			// 		subscription.unsubscribe();
			// 		resolve(data.variables || []);
			// 	}
			// });
		});
	}

	public disconnect() {
	}

	private request(method: 'GET' | 'POST', controller: 'Breakpoint' | 'Variable' | 'Debug', endpoint: string, body?: any, timeout?: number): Observable<any> {
		return new Observable(observer => {
			const url = `http://localhost:5000/${controller}/${endpoint}`;
			fetch(url, { method, body: body ? JSON.stringify(body, formatKeysAPI) : undefined, timeout: timeout || 5000, headers: new Headers({ 'content-type': 'application/json' }) })
				.then(response => {
					response.json()
						.then(value => observer.next(value))
						.catch(() => this.sendEvent('end'));
				})
				.catch(() => this.sendEvent('end'));
		});
	}

	private sendEvent(event: string, ...args: any[]): void {
		setImmediate(() => {
			this.emit(event, ...args);
		});
	}
}

function formatKeysAPI(key: string, value: any): any {
	const result = {};

	if (key && key.length) {
		const fkey = `${key[0].toUpperCase()}${key.substring(1)}`;
		result[fkey] = value;
	}

	return result;
}

