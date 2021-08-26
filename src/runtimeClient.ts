import { EventEmitter } from 'events';
import { Socket } from 'net';
import fetch, { Headers } from 'node-fetch';
import { forkJoin, Observable, Subject, Subscriber } from 'rxjs';

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

export class RuntimeClient extends EventEmitter {
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


	public start(path: string, stopOnEntry = false): Promise<any> {
		return new Promise(async (resolve, _) => {
			this.sourcePath = path;
			this.sourceText = await this.fileAccessor.readFile(this.sourcePath);

			const subscription = forkJoin([
				this.request('POST', 'Debug', 'Load', { file: this.sourceText }),
				this.request('POST', 'Debug', 'Start', { stopOnEntry })
			]).subscribe(data => {
				const error = data[0]?.error || data[1]?.error;
				const event = data[1]?.event || '';

				if (!error && event) {
					this.sendEvent(event);
				}

				resolve({ error, event });
				subscription.unsubscribe();
			});
		});
	}

	public getBreakpoints(): Promise<{ line: number }[]> {
		return new Promise((resolve, _) => {
			const subscription = this.request('GET', 'Breakpoint', 'Get').subscribe(data => {
				resolve(data);
				subscription.unsubscribe();
			});
		});
	}

	public setBreakPoint(line: number): RuntimeBreakpoint | PromiseLike<RuntimeBreakpoint> {
		return new Promise((resolve, _) => {
			const subscription = this.request('POST', 'Breakpoint', 'Set', { line }).subscribe(data => {
				resolve(data);
				subscription.unsubscribe();
			});
		});
	}

	public clearBreakpoints(): Promise<void> {
		return new Promise((resolve, _) => {
			const subscription = this.request('PATCH', 'Breakpoint', 'Clear').subscribe(() => {
				resolve();
				subscription.unsubscribe();
			});
		});
	}

	public step(): Promise<boolean> {
		return new Promise((resolve, _) => {
			const subscription = this.request('PATCH', 'Debug', 'Step').subscribe(data => {
				if (data.event) {
					this.sendEvent(data?.event);
				}

				resolve(data);
				subscription.unsubscribe();
			});
		});
	}

	public getStackFrames(): Promise<RuntimeStackframes> {
		return new Promise((resolve, _) => {
			const subscription = this.request('GET', 'Stackframe', 'Get').subscribe(data => {
				const frames = (data.frames || []).map((item: RuntimeStackframe) => ({ ...item, file: this.sourcePath || '' }));
				resolve({ ...data, frames });
				subscription.unsubscribe();
			});
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
		return new Promise((resolve, _) => {
			const subscription = this.request('GET', 'Variable', 'Get').subscribe(data => {
				resolve(data);
				subscription.unsubscribe();
			});
		});
	}

	public disconnect() {
	}

	private request(method: 'GET' | 'POST' | 'PATCH', controller: 'Breakpoint' | 'Variable' | 'Debug' | 'Stackframe', endpoint: string, body?: any, timeout?: number): Observable<any> {
		return new Observable(observer => {
			const url = `http://localhost:5000/${controller}/${endpoint}`;
			fetch(url, { method, body: body ? JSON.stringify(formatKeysAPI(body)) : undefined, headers: new Headers({ 'content-type': 'application/json' }) })
				.then(response => {
					response.json()
						.then(value => { observer.next(value); observer.complete(); })
						.catch(error => this.handleError(error, observer));
				})
				.catch(error => this.handleError(error, observer));
		});
	}

	private sendEvent(event: string, ...args: any[]): void {
		setImmediate(() => {
			this.emit(event, ...args);
		});
	}

	private handleError(error: any, observer: Subscriber<any>) {
		console.log(error);
		observer.next(null);
		observer.complete();
		this.sendEvent('end');
	}
}

function formatKeysAPI(value: any): any {
	const result = {};
	const keys = Object.keys(value);

	if (keys?.length) {
		for (const key of keys) {
			const fkey = `${key[0].toUpperCase()}${key.substring(1)}`;
			result[fkey] = value[key];
		}
	}

	return result;
}

