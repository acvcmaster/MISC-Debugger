/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/


import { DebugProtocol } from 'vscode-debugprotocol';
// import { basename } from 'path';
import { FileAccessor, RuntimeClient, RuntimeBreakpoint } from './runtimeClient';
import { Subject } from 'await-notify';
import { LoggingDebugSession, StoppedEvent, InitializedEvent, logger, Logger, Breakpoint, BreakpointEvent, Scope, Thread, OutputEvent, Source, TerminatedEvent, StackFrame, Handles } from 'vscode-debugadapter';
import { basename } from 'path';

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
}

export class DebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// The runtime client
	private runtimeClient: RuntimeClient;
	private configurationDone = new Subject();
	private handles = new Handles<'locals' | 'globals' | any>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this.runtimeClient = new RuntimeClient(fileAccessor);

		// setup event handlers
		this.setupEvents();
	}

	/** Setup event handlers */
	protected setupEvents() {
		this.runtimeClient.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', DebugSession.threadID));
		});
		this.runtimeClient.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', DebugSession.threadID));
		});
		this.runtimeClient.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', DebugSession.threadID));
		});
		this.runtimeClient.on('stopOnException', (exception) => {
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, DebugSession.threadID));
			} else {
				this.sendEvent(new StoppedEvent('exception', DebugSession.threadID));
			}
		});
		this.runtimeClient.on('breakpointValidated', (breakpoint: RuntimeBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: breakpoint.verified, id: breakpoint.id } as DebugProtocol.Breakpoint));
		});
		this.runtimeClient.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);

			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);

			this.sendEvent(e);
		});
		this.runtimeClient.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// build and return the capabilities of this debug adapter:
		this.setCapabilities(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	private setCapabilities(response: DebugProtocol.InitializeResponse) {
		response.body = response.body || {};
		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;
		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;
		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		this.sendResponse(response);
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this.configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this.configurationDone.wait(1000);

		// start the program in the runtime
		const startResponse = await this.runtimeClient.start(args.program, !!args.stopOnEntry);

		if (startResponse.error) {
			// simulate a compile/build error in "launch" request:
			// the error should not result in a modal dialog since 'showUser' is set to false.
			// A missing 'showUser' should result in a modal dialog.
			this.sendErrorResponse(response, {
				id: 1001,
				format: `Runtime: ${startResponse.error}`,
				showUser: true
			});
		} else {
			this.sendResponse(response);
		}
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		this.runtimeClient.disconnect();
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		await this.runtimeClient.clearBreakpoints();

		// set and verify breakpoint locations
		const trueBreakpoints = clientLines.map(async l => {
			const { verified, line, id } = await this.runtimeClient.setBreakPoint(this.convertClientLineToDebugger(l));
			const breakpoint = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
			return { ...breakpoint, id };
		});

		const breakpoints = await Promise.all<DebugProtocol.Breakpoint>(trueBreakpoints);

		// send back the actual breakpoint positions
		this.sendResponse({ ...response, body: { ...response.body, breakpoints } });
	}

	protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): Promise<void> {
		const breakpoints = await this.runtimeClient.getBreakpoints(); // array
		this.sendResponse({ ...response, body: { ...breakpoints } });
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(DebugSession.threadID, "Thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const stackFrames = await this.runtimeClient.getStackFrames();

		response.body = {
			stackFrames: stackFrames.frames.map(frame =>
				new StackFrame(frame.index, frame.name,
					this.createSource(frame.file), this.convertDebuggerLineToClient(frame.line))),
			totalFrames: stackFrames.count
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Globals", this.handles.create('globals'), false)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		const variables = await this.runtimeClient.getVariables();

		response.body = {
			variables: variables?.map(variable => this.getDebugVariable(variable))
		};

		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// const scope = this.handles.get(args.variablesReference);
		// if (scope === 'locals') {
		// 	const rv = this._runtime.getLocalVariable(args.name);
		// 	if (rv) {
		// 		rv.value = this.convertToRuntime(args.value);
		// 		response.body = this.convertFromRuntime(rv);
		// 	}
		// }
		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		await this.runtimeClient.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this.runtimeClient.step();
		this.sendResponse(response);
	}

	private getDebugVariable(variable: any): DebugProtocol.Variable {

		let debugVariable: DebugProtocol.Variable = {
			name: variable.name,
			value: variable.value,
			type: variable.type,
			variablesReference: 0,
			evaluateName: variable.evaluateName
		};

		(<any>debugVariable).__vscodeVariableMenuContext = 'simple';	// enable context menu contribution

		return debugVariable as DebugProtocol.Variable;
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}

