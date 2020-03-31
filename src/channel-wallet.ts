import {Store} from './store';
import {MessagingServiceInterface, convertToChannelResult} from './messaging';

import ReactDOM from 'react-dom';
import React from 'react';
import {Wallet as WalletUi} from './ui/wallet';
import {interpret, Interpreter, State, StateNode} from 'xstate';
import {Guid} from 'guid-typescript';
import {Notification, Response} from '@statechannels/client-api-schema';
import {filter, take} from 'rxjs/operators';
import {Message, isOpenChannel, OpenChannel} from './store/types';

import {ApproveBudgetAndFund, CloseLedgerAndWithdraw, Application} from './workflows';
import {ethereumEnableWorkflow} from './workflows/ethereum-enable';
import {AppRequestEvent} from './event-types';

export interface Workflow {
  id: string;
  machine: Interpreter<any, any, any>;
  domain: string; // TODO: Is this useful?
}
export class ChannelWallet {
  public workflows: Workflow[];

  constructor(
    private store: Store,
    private messagingService: MessagingServiceInterface,
    public id?: string
  ) {
    this.workflows = [];

    // Whenever the store wants to send something call sendMessage
    store.outboxFeed.subscribe(async (m: Message) => {
      this.messagingService.sendMessageNotification(m);
    });
    // Whenever an OpenChannel objective is received
    // we alert the user that there is a new channel
    // It is up to the app to call JoinChannel
    this.store.objectiveFeed.pipe(filter(isOpenChannel)).subscribe(async o => {
      const channelEntry = await this.store
        .channelUpdatedFeed(o.data.targetChannelId)
        .pipe(take(1))
        .toPromise();

      this.startWorkflow(
        Application.workflow(this.store, this.messagingService, {} as any),
        this.calculateWorkflowId(o)
      ); // FIXME: add proper context

      this.messagingService.sendChannelNotification('ChannelProposed', {
        ...(await convertToChannelResult(channelEntry)),
        fundingStrategy: o.data.fundingStrategy
      });
    });

    this.messagingService.requestFeed.subscribe(x => this.handleRequest(x));
  }

  private isWorkflowIdInUse(workflowId: string): boolean {
    return this.workflows.map(w => w.id).indexOf(workflowId) > -1;
  }

  public getWorkflow(workflowId: string): Workflow {
    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow) throw Error('Workflow not found');
    return workflow;
  }

  // Deterministic workflow ids for certain workflows allows us to avoid spawning a duplicate workflow if the app sends duplicate requests
  private calculateWorkflowId(request: AppRequestEvent | OpenChannel): string {
    switch (request.type) {
      case 'JOIN_CHANNEL':
        return `${request.type}-${request.channelId}`;
      case 'OpenChannel':
        return `JOIN_CHANNEL-${request.data.targetChannelId}`;
      case 'APPROVE_BUDGET_AND_FUND':
        return `${request.type}-${request.player.participantId}-${request.hub.participantId}`;
      default:
        return `${request.type}-${Guid.create().toString()}`;
    }
  }
  private handleRequest(request: AppRequestEvent) {
    const workflowId = this.calculateWorkflowId(request);
    switch (request.type) {
      case 'CREATE_CHANNEL': {
        if (!this.isWorkflowIdInUse(workflowId)) {
          const workflow = this.startWorkflow(
            Application.workflow(this.store, this.messagingService, {
              fundingStrategy: 'Direct',
              applicationSite: request.applicationSite
            }), // FIXME
            workflowId
          );

          workflow.machine.send(request);
        } else {
          // TODO: To allow RPS to keep working we just warn about duplicate events
          // Eventually this could probably be an error
          console.warn(
            `There is already a workflow running with id ${workflowId}, no new workflow will be spawned`
          );
        }
        break;
      }
      case 'JOIN_CHANNEL':
        this.getWorkflow(this.calculateWorkflowId(request)).machine.send(request);
        break;
      case 'APPROVE_BUDGET_AND_FUND': {
        const workflow = this.startWorkflow(
          ApproveBudgetAndFund.machine(this.store, this.messagingService, {
            player: request.player,
            hub: request.hub,
            budget: request.budget,
            requestId: request.requestId
          }),
          workflowId,
          true // devtools
        );

        workflow.machine.send(request);
        break;
      }
      case 'CLOSE_AND_WITHDRAW': {
        this.startWorkflow(
          CloseLedgerAndWithdraw.workflow(this.store, this.messagingService, {
            opponent: request.hub,
            player: request.player,
            requestId: request.requestId,
            site: request.site
          }),
          workflowId
        );
        break;
      }
      case 'ENABLE_ETHEREUM': {
        this.startWorkflow(
          ethereumEnableWorkflow(this.store, this.messagingService, {requestId: request.requestId}),
          workflowId
        );
        break;
      }
    }
  }
  private startWorkflow(
    machineConfig: StateNode<any, any, any, any>,
    workflowId: string,
    devTools = false
  ): Workflow {
    if (this.isWorkflowIdInUse(workflowId)) {
      throw new Error(`There is already a workflow running with id ${workflowId}`);
    }
    const machine = interpret<any, any, any>(machineConfig, {devTools: true})
      .onTransition(
        (state, event) => process.env.ADD_LOGS && logTransition(state, event, workflowId)
      )
      .onDone(() => (this.workflows = this.workflows.filter(w => w.id !== workflowId)))
      .start();
    // TODO: Figure out how to resolve rendering priorities
    this.renderUI(machine);

    const workflow = {id: workflowId, machine, domain: 'TODO'};
    this.workflows.push(workflow);
    return workflow;
  }

  private renderUI(machine) {
    if (document.getElementById('root')) {
      ReactDOM.render(
        React.createElement(WalletUi, {workflow: machine}),
        document.getElementById('root')
      );
    }
  }

  public async pushMessage(jsonRpcMessage, fromDomain) {
    // Update any workflows waiting on an observable
    await this.messagingService.receiveRequest(jsonRpcMessage, fromDomain);
  }

  public onSendMessage(callback: (jsonRpcMessage: Notification | Response) => void) {
    this.messagingService.outboxFeed.subscribe(m => callback(m));
  }
}

export function logTransition(
  state: State<any, any, any, any>,
  event,
  id?: string,
  logger = console
): void {
  const to = JSON.stringify(state.value);
  if (!state.history) {
    logger.log(`${id || ''} - STARTED ${state.configuration[0].id} TRANSITIONED TO ${to}`);
  } else {
    const from = JSON.stringify(state.history.value);
    const eventType = JSON.stringify(event.type ? event.type : event);

    logger.log(`${id || ''} - TRANSITION FROM ${from} EVENT ${eventType} TO  ${to}`);
  }
  Object.keys(state.children).forEach(k => {
    const child = state.children[k];

    if (child.state && 'onTransition' in child) {
      const subId = (child as any).state.configuration[0].id;
      (child as any).onTransition((state, event) =>
        logTransition(state, event, `${id} - ${subId}`)
      );
    }
  });
}
