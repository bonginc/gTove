import {v4} from 'uuid';
import {memoize, throttle} from 'lodash';
import {remove, serverTimestamp, Unsubscribe} from 'firebase/database';
import {getAuth} from 'firebase/auth';

import {CommsNode, CommsNodeOptions, SendToOptions} from './commsNode';
import {firebaseApp} from './googleAPI';
import {
    child,
    get,
    getDatabase,
    onChildAdded, onChildRemoved,
    push,
    ref,
    set,
    TypedDatabase,
    TypedDatabaseReference
} from './typedFirebase';
import {TabletopValidationActionTypes} from '../redux/tabletopValidationReducer';

interface GToveFirebaseDB {
    tabletop: {
        [tabletopId: string] : {
            gm?: string;
            users?: {
                [clientId: string]: {
                    userId: string;
                    heartbeatTimestamp: number;
                }
            };
            actions?: {
                [id: string]: {
                    json: string;
                    fromClientId: string;
                }
            };
            gmActions?: {
                [id: string]: {
                    json: string;
                    fromClientId: string;
                }
            };
        }
    }
}

export class FirebaseNode extends CommsNode {

    private readonly memoizedThrottle: (key: string, func: (...args: any[]) => any) => (...args: any[]) => any;
    private readonly realTimeDB: TypedDatabase<GToveFirebaseDB>;
    private readonly channelId: string;
    private readonly isGM: boolean;

    private unsubscribe: (Unsubscribe | undefined)[] = [];

    /**
     * @param channelId The unique string used to identify the tabletop being shared.  All FirebaseNodes with the same
     * channelId will signal each other and connect.
     * @param isGM True if this user is the GM.
     * @param commsNodeOptions The options this node is initialised with
     */
    constructor(channelId: string, isGM: boolean, commsNodeOptions: CommsNodeOptions) {
        super();
        this.peerId = v4();
        this.channelId = channelId;
        this.isGM = isGM;
        this.userId = getAuth().currentUser!.uid!;
        this.options = commsNodeOptions;
        const throttleWait = commsNodeOptions.throttleWait || 250;
        // Create a memoized throttle function wrapper.  Calls with the same (truthy) throttleKey will be throttled so
        // the function is called at most once each throttleWait milliseconds.  This is used to wrap the send function,
        // so things like dragging minis doesn't flood the connection - since each position update supersedes the
        // previous one, we don't need to send every intermediate value.
        this.memoizedThrottle = memoize((throttleKey, func) => (throttle(func, throttleWait)));
        this.sendToRaw = this.sendToRaw.bind(this);
        this.realTimeDB = getDatabase<GToveFirebaseDB>(firebaseApp);
    }

    async init(): Promise<void> {
        if (this.isGM) {
            const gmRef = ref(this.realTimeDB, `tabletop/${this.channelId}/gm`);
            if (!(await get(gmRef)).exists()) {
                await set(gmRef, this.userId);
            }
        }
        const usersRef = ref(this.realTimeDB, `tabletop/${this.channelId}/users`);
        await set(child(usersRef, this.peerId), {
            userId: this.userId,
            heartbeatTimestamp: serverTimestamp() as any // placeholder value to auto-populate the current timestamp
        });
        this.unsubscribe = [
            onChildAdded(usersRef, async (snapshot) => {
                const otherPeerId = snapshot.key!;
                const {heartbeatTimestamp} = snapshot.val();
                // Use our own heartbeatTimestamp to determine if other connections are stale or not, rather than
                // Date.now(), to avoid issues with clock skew between the Firebase server and our client.
                const myHeartbeatTimestamp = (
                    await get(ref(this.realTimeDB, `tabletop/${this.channelId}/users/${this.peerId}/heartbeatTimestamp`))
                ).val()!;
                if (otherPeerId !== this.peerId && heartbeatTimestamp >= myHeartbeatTimestamp - 2 * FirebaseNode.HEARTBEAT_INTERVAL_MS) {
                    console.log('Established connection with', otherPeerId);
                    await this.options.onEvents?.connect?.(this, otherPeerId);
                }
            }),
            onChildRemoved(usersRef, async (snapshot) => {
                const otherPeerId = snapshot.key!;
                if (otherPeerId !== this.peerId) {
                    await this.options.onEvents?.close?.(this, otherPeerId);
                }
            }),
            onChildAdded(ref(this.realTimeDB, `tabletop/${this.channelId}/actions`), ((snapshot) => {
                const {json, fromClientId} = snapshot.val();
                if (fromClientId !== this.peerId) {
                    this.options.onEvents?.data?.(this, fromClientId, json);
                }
            })),
            !this.isGM
                ? undefined
                : onChildAdded(ref(this.realTimeDB, `tabletop/${this.channelId}/gmActions`), ((snapshot) => {
                    const {json, fromClientId} = snapshot.val();
                    if (fromClientId !== this.peerId) {
                        this.options.onEvents?.data?.(this, fromClientId, json);
                    }
            }))
        ];
        console.log(`Created Firebase communication node with id ${this.peerId}`);
    }

    private async sendToRaw(message: object, gmOnly: boolean, onSentMessage?: (recipients: string[], message: string | object) => void): Promise<void> {
        // JSON has no "undefined" value, so if JSON-stringifying, convert undefined values to null.
        const json: string = (typeof(message) === 'object') ?
            JSON.stringify(message, (k, v) => (v === undefined ? null : v)) : message;
        if (gmOnly) {
            await push(ref(this.realTimeDB, `tabletop/${this.channelId}/gmActions`), {json, fromClientId: this.peerId});
        } else {
            await push(ref(this.realTimeDB, `tabletop/${this.channelId}/actions`), {json, fromClientId: this.peerId});
        }
        onSentMessage?.([], message);
    }

    async sendTo(message: object, {throttleKey, onSentMessage}: SendToOptions = {}): Promise<void> {
        if (this.isGM) {
            const actionType = message['type'] as string | undefined;
            // We can clean up actions from the RTDB that predate the saved tabletop.
            if (actionType === TabletopValidationActionTypes.SET_LAST_SAVED_HEAD_ACTION_IDS_ACTION) {
                await cleanUpActions(actionType, ref(this.realTimeDB, `tabletop/${this.channelId}/gmActions`));
            } else if (actionType === TabletopValidationActionTypes.SET_LAST_SAVED_PLAYER_HEAD_ACTION_IDS_ACTION) {
                await cleanUpActions(actionType, ref(this.realTimeDB, `tabletop/${this.channelId}/actions`));
            }
        }
        const gmOnly = message['gmOnly'] ?? false;
        if (throttleKey) {
            await this.memoizedThrottle(throttleKey, this.sendToRaw)(message, gmOnly, onSentMessage);
        } else {
            await this.sendToRaw(message, gmOnly, onSentMessage);
        }
    }

    async close(peerId: string, reason?: string): Promise<void> {
        console.log('Lost connection with', peerId);
    }

    async destroy(): Promise<void> {
        console.log('Shutting down Firebase node', this.peerId);
        await remove(ref(this.realTimeDB, `tabletop/${this.channelId}/users/${this.peerId}`));
        this.options.onEvents?.close?.(this, this.peerId);
        this.unsubscribe.forEach((callback) => (callback?.()));
    }

    async disconnectAll(): Promise<void> {
        await this.destroy();
    }

    async heartbeat() {
        await set(
            ref(this.realTimeDB, `tabletop/${this.channelId}/users/${this.peerId}/heartbeatTimestamp`),
            serverTimestamp() as any // placeholder value to auto-populate the current timestamp
        );
    }

}

/**
 * The network hub has saved the tabletop, so delete actions which are older than the last time the tabletop was saved.
 */
async function cleanUpActions(
    actionType: string,
    firebaseRef: TypedDatabaseReference<{[id: string]: {json: string; fromClientId: string}}, GToveFirebaseDB>
) {
    const actionsSnapshot = await get(firebaseRef);
    if (actionsSnapshot.exists()) {
        // Find the last time an action with this actionType was sent
        const actions = actionsSnapshot.val();
        const firebaseIds = Object.keys(actions).reverse();
        const matchIndex = firebaseIds.findIndex((id) => (actions[id].json.includes(`"type":"${actionType}"`)));
        if (matchIndex >= 0) {
            // Delete actions from that index on.
            await Promise.all(firebaseIds.slice(matchIndex).map((id) => (remove(child(firebaseRef, id)))));
        }
    }
}