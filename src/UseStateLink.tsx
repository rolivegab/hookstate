import React from 'react';
import { ObjectStateMutation, createObjectStateMutation } from './UseStateObject';
import { ArrayStateMutation, createArrayStateMutation } from './UseStateArray';

//
// DECLARATIONS
//

export interface PluginTypeMarker<S, E extends {}> { }

export interface StateRef<S, E extends {}> {
    with<I>(plugin: (marker: PluginTypeMarker<S, E>) => Plugin<E, I>): StateRef<S, E & I>;
}

// TODO add support for Map and Set
export type NestedInferredLink<S, E extends {}> =
    S extends ReadonlyArray<(infer U)> ? ReadonlyArray<StateLink<U, E>> :
    S extends null ? undefined :
    S extends object ? { readonly [K in keyof Required<S>]: StateLink<S[K], E>; } :
    undefined;

// TODO add support for Map and Set
export type InferredStateMutation<S> =
    S extends ReadonlyArray<(infer U)> ? ArrayStateMutation<U> :
    S extends null ? undefined :
    S extends object ? ObjectStateMutation<S> :
    undefined;

export type Path = ReadonlyArray<string | number>;

export interface StateLink<S, E extends {} = {}> {
    readonly path: Path;
    readonly value: S;

    // shortcut for nested
    readonly nested: NestedInferredLink<S, E>;

    readonly inferred: InferredStateMutation<S>;
    readonly extended: E;

    set(newValue: React.SetStateAction<S>): void;
    with<I>(plugin: (marker: PluginTypeMarker<S, E>) => Plugin<E, I>): StateLink<S, E & I>;
}
// keep temporary for backward compatibility with the previous version
export type ValueLink<S, E extends {} = {}> = StateLink<S, E>;

// type alias to highlight the places where we are dealing with root state value
// tslint:disable-next-line: no-any
export type StateValueAtRoot = any;
// tslint:disable-next-line: no-any
export type StateValueAtPath = any;
// tslint:disable-next-line: no-any
export type TransformResult = any;

export interface PluginInstance<E extends {}, I extends {}> {
    // if returns defined value,
    // it overrides the current / initial value in the state
    // it is only applicable for plugins attached via stateref, not via statelink
    onInit?: () => StateValueAtRoot | void,
    onAttach?: (path: Path, withArgument: PluginInstance<{}, {}>) => void,
    onSet?: (path: Path, newValue: StateValueAtRoot) => void,

    extensions: (keyof I)[],
    // thisLink can be anything, not only root link with value of type S
    extensionsFactory: (thisLink: StateLink<StateValueAtPath, E>) => I
};

export interface Plugin<E extends {}, I extends {}> {
    id: symbol;
    // initial value may not be of the same type as the target value type,
    // because it is coming from the state and represents the type of the root value
    instanceFactory: (initial: StateValueAtRoot) => PluginInstance<E, I>;
}

//
// INTERNAL IMPLEMENTATIONS
//

class StateLinkInvalidUsageError extends Error {
    constructor(op: string, path: Path) {
        super(`StateLink is used incorrectly. Attempted '${op}' at '/${path.join('/')}'`)
    }
}

class ExtensionInvalidUsageError extends Error {
    constructor(op: string, path: Path) {
        super(`Extension is used incorrectly. Attempted '${op}' at '/${path.join('/')}'`)
    }
}

class ExtensionInvalidRegistrationError extends Error {
    constructor(id: symbol, path: Path) {
        super(`Extension with onInit, which overrides initial value, ` +
        `should be attached to StateRef instance, but not to StateLink instance. ` +
        `Attempted 'with ${id.toString()}' at '/${path.join('/')}'`)
    }
}

class ExtensionConflictRegistrationError extends Error {
    constructor(newId: symbol, existingId: symbol, ext: string) {
        super(`Extension '${ext}' is already registered for '${existingId.toString()}'. ` +
        `Attempted 'with ${newId.toString()}''`)
    }
}

class ExtensionUnknownError extends Error {
    constructor(ext: string) {
        super(`Extension '${ext}' is unknown'`)
    }
}

interface Subscriber {
    onSet(path: Path, actions: (() => void)[]): void;
}

interface Subscribable {
    subscribe(l: Subscriber): void;
    unsubscribe(l: Subscriber): void;
}

const DisabledTrackingID = Symbol('DisabledTracking');
const PrerenderID = Symbol('Prerender');

const HiddenPluginId = Symbol('PluginID');
const RootPath: Path = [];

class State implements Subscribable {
    private _subscribers: Set<Subscriber> = new Set();

    private _extensions: Record<string, PluginInstance<{}, {}>> = {};
    private _plugins: Map<symbol, PluginInstance<{}, {}>> = new Map();

    constructor(private _value: StateValueAtRoot) { }

    get(path: Path) {
        let result = this._value;
        path.forEach(p => {
            result = result[p];
        });
        return result;
    }

    set(path: Path, value: StateValueAtPath) {
        if (path.length === 0) {
            this._value = value;
        }
        let result = this._value;
        path.forEach((p, i) => {
            if (i === path.length - 1) {
                if (!(p in result)) {
                    // if an array of object is about to be extended by new property
                    // we consider it is the whole object is changed
                    // which is identified by upper path
                    path = path.slice(0, -1)
                }
                result[p] = value;
            } else {
                result = result[p];
            }
        });
        const actions: (() => void)[] = [];
        this._subscribers.forEach(s => s.onSet(path, actions));
        actions.forEach(a => a());
    }

    extensions() {
        return this._extensions;
    }

    register(plugin: Plugin<{}, {}>, path?: Path | undefined) {
        const existingInstance = this._plugins.get(plugin.id)
        if (existingInstance) {
            if (existingInstance.onAttach) {
                existingInstance.onAttach(path || RootPath, plugin.instanceFactory(this._value))
            }
            return;
        }
        const pluginInstance = plugin.instanceFactory(this._value);
        this._plugins.set(plugin.id, pluginInstance);
        if (pluginInstance.onInit) {
            const initValue = pluginInstance.onInit()
            if (initValue !== undefined) {
                if (path) {
                    throw new ExtensionInvalidRegistrationError(plugin.id, path);
                }
                this._value = initValue;
            }
        }
        if (pluginInstance.onAttach) {
            pluginInstance.onAttach(path || RootPath, pluginInstance)
        }
        const extensions = pluginInstance.extensions;
        extensions.forEach(e => {
            if (e in this._extensions) {
                throw new ExtensionConflictRegistrationError(
                    plugin.id,
                    this._extensions[e as string][HiddenPluginId],
                    e as string);
            }
            pluginInstance[HiddenPluginId] = plugin.id;
            this._extensions[e as string] = pluginInstance;
        });
        if (pluginInstance.onSet) {
            const onSet = pluginInstance.onSet;
            this.subscribe({
                onSet: (p) => onSet(p, this._value)
            })
        }
        return;
    }

    subscribe(l: Subscriber) {
        this._subscribers.add(l);
    }

    unsubscribe(l: Subscriber) {
        this._subscribers.delete(l);
    }
}

class StateRefImpl<S, E extends {}> implements StateRef<S, E> {
    public disabledTracking: boolean | undefined;

    constructor(public state: State) { }

    with<I extends {}>(plugin: (marker: PluginTypeMarker<S, E>) => Plugin<E, I>): StateRef<S, E & I> {
        const pluginMeta = plugin({})
        if (pluginMeta.id === DisabledTrackingID) {
            this.disabledTracking = true;
            return this as unknown as StateRef<S, E & I>;
        }
        this.state.register(pluginMeta as unknown as Plugin<{}, {}>);
        return this as unknown as StateRef<S, E & I>;
    }
}

class StateLinkImpl<S, E extends {}> implements StateLink<S, E>, Subscribable, Subscriber {
    public disabledTracking: boolean | undefined;
    private subscribers: Set<Subscriber> | undefined;

    private nestedCache: NestedInferredLink<S, E> | undefined;
    private nestedLinksCache: Record<string | number, StateLinkImpl<S[keyof S], E>> | undefined;

    private valueTracked: S | undefined;
    private valueUsed: boolean | undefined;

    constructor(
        public readonly state: State,
        public readonly path: Path,
        public onUpdateUsed: () => void,
        public valueUntracked: S
    ) { }

    get value(): S {
        if (this.valueTracked === undefined) {
            if (this.disabledTracking) {
                this.valueTracked = this.valueUntracked;
                if (this.valueTracked === undefined) {
                    this.valueUsed = true;
                }
            } else if (Array.isArray(this.valueUntracked)) {
                this.valueTracked = this.valueArrayImpl();
            } else if (typeof this.valueUntracked === 'object' && this.valueUntracked !== null) {
                this.valueTracked = this.valueObjectImpl();
            } else {
                this.valueTracked = this.valueUntracked;
                if (this.valueTracked === undefined) {
                    this.valueUsed = true;
                }
            }
        }
        return this.valueTracked!;
    }

    set(newValue: React.SetStateAction<S>): void {
        // inferred() function checks for the nullability of the current value:
        // If value is not null | undefined, it resolves to ArrayLink or ObjectLink
        // which can not take null | undefined as a value.
        // However, it is possible that a user of this ValueLink
        // may call set(null | undefined).
        // In this case this null will leak via setValue(prevValue => ...)
        // to mutation actions for array or object,
        // which breaks the guarantee of ArrayStateMutation and ObjectStateMutation to not link nullable value.
        // Currently this causes a crash within ObjectStateMutation or ArrayStateMutation mutation actions.
        // This behavior is left intentionally to make it equivivalent to the following:
        // Example (plain JS):
        //    let myvar: { a: string, b: string } = { a: '', b: '' }
        //    myvar = undefined;
        //    myvar.a = '' // <-- crash here
        //    myvar = { a: '', b: '' } // <-- OK
        // Example (using value links):
        //    let myvar = useStateLink({ a: '', b: '' } as { a: string, b: string } | undefined);
        //    let myvar_a = myvar.nested.a; // get value link to a property
        //    myvar.set(undefined);
        //    myvar_a.set('') // <-- crash here
        //    myvar.set({ a: '', b: '' }) // <-- OK
        if (typeof newValue === 'function') {
            newValue = (newValue as ((prevValue: S) => S))(this.state.get(this.path));
        }
        this.state.set(this.path, newValue);
    }

    with<I>(plugin: (marker: PluginTypeMarker<S, E>) => Plugin<E, I>): StateLink<S, E & I> {
        const pluginMeta = plugin({});
        if (pluginMeta.id === DisabledTrackingID) {
            this.disabledTracking = true;
            return this as unknown as StateLink<S, E & I>;
        }
        this.state.register(pluginMeta as unknown as Plugin<{}, {}>, this.path);
        return this as unknown as StateLink<S, E & I>;
    }

    get extended() {
        const getter = (target: Record<string, PluginInstance<{}, {}>>, key: PropertyKey) => {
            if (typeof key === 'symbol') {
                return undefined;
            }
            const plugin = target[key];
            if (plugin === undefined) {
                throw new ExtensionUnknownError(key.toString());
            }
            // tslint:disable-next-line: no-any
            const extension: any = plugin.extensionsFactory(this)[key];
            if (extension === undefined) {
                throw new ExtensionUnknownError(key.toString());
            }
            return extension;
        };
        return this.proxyWrap(this.state.extensions(), getter, o => {
            throw new ExtensionInvalidUsageError(o, this.path)
        });
    }

    subscribe(l: Subscriber) {
        if (this.subscribers === undefined) {
            this.subscribers = new Set();
        }
        this.subscribers.add(l);
    }

    unsubscribe(l: Subscriber) {
        this.subscribers!.delete(l);
    }

    onSet(path: Path, actions: (() => void)[]) {
        this.updateIfUsed(path, actions)
    }

    updateIfUsed(path: Path, actions: (() => void)[]): boolean {
        const update = () => {
            if (this.disabledTracking && (this.valueTracked !== undefined || this.valueUsed === true)) {
                actions.push(this.onUpdateUsed);
                return true;
            }
            const firstChildKey = path[this.path.length];
            if (firstChildKey === undefined) {
                if (this.valueTracked !== undefined || this.valueUsed === true) {
                    actions.push(this.onUpdateUsed);
                    return true;
                }
                return false;
            }
            const firstChildValue = this.nestedLinksCache && this.nestedLinksCache[firstChildKey];
            if (firstChildValue === undefined) {
                return false;
            }
            return firstChildValue.updateIfUsed(path, actions);
        }

        const updated = update();
        if (!updated && this.subscribers !== undefined) {
            this.subscribers.forEach(s => {
                s.onSet(path, actions)
            })
        }
        return updated;
    }

    get inferred(): InferredStateMutation<S> {
        if (!this.valueTracked) {
            this.valueUsed = true;
        }
        if (Array.isArray(this.valueUntracked)) {
            return createArrayStateMutation((newValue) =>
            // tslint:disable-next-line: no-any
            this.set(newValue as any)) as unknown as InferredStateMutation<S>
        } else if (typeof this.valueUntracked === 'object' && this.valueUntracked !== null) {
            return createObjectStateMutation((newValue) =>
            // tslint:disable-next-line: no-any
            this.set(newValue as any)) as unknown as InferredStateMutation<S>;
        } else {
            return undefined as unknown as InferredStateMutation<S>;
        }
    }

    get nested(): NestedInferredLink<S, E> {
        if (!this.valueTracked) {
            this.valueUsed = true;
        }
        if (this.nestedCache === undefined) {
            if (Array.isArray(this.valueUntracked)) {
                this.nestedCache = this.nestedArrayImpl();
            } else if (typeof this.valueUntracked === 'object' && this.valueUntracked !== null) {
                this.nestedCache = this.nestedObjectImpl();
            } else {
                this.nestedCache = undefined;
            }
        }
        return this.nestedCache as NestedInferredLink<S, E>;
    }

    private nestedArrayImpl(): NestedInferredLink<S, E> {
        const proxyGetterCache = {};
        this.nestedLinksCache = proxyGetterCache;

        const getter = (target: object, key: PropertyKey) => {
            if (key === 'length') {
                return (target as []).length;
            }
            if (key in Array.prototype) {
                return Array.prototype[key];
            }
            const index = Number(key);
            if (!Number.isInteger(index)) {
                return undefined;
            }
            const cachehit = proxyGetterCache[index];
            if (cachehit) {
                return cachehit;
            }
            const r = new StateLinkImpl(
                this.state,
                this.path.slice().concat(index),
                this.onUpdateUsed,
                target[index]
            )
            if (this.disabledTracking) {
                r.disabledTracking = true;
            }
            proxyGetterCache[index] = r;
            return r;
        };
        return this.proxyWrap(this.valueUntracked as unknown as object, getter, o => {
            throw new StateLinkInvalidUsageError(o, this.path)
        }) as unknown as NestedInferredLink<S, E>;
    }

    private valueArrayImpl(): S {
        const getter = (target: object, key: PropertyKey) => {
            if (key === 'length') {
                return (target as []).length;
            }
            if (key in Array.prototype) {
                return Array.prototype[key];
            }
            const index = Number(key);
            if (!Number.isInteger(index)) {
                return undefined;
            }
            return (this.nested)![index].value;
        };
        return this.proxyWrap(this.valueUntracked as unknown as object, getter, o => {
            throw new StateLinkInvalidUsageError(o, this.path)
        }) as unknown as S;
    }

    private nestedObjectImpl(): NestedInferredLink<S, E> {
        const proxyGetterCache = {}
        this.nestedLinksCache = proxyGetterCache;

        const getter = (target: object, key: PropertyKey) => {
            if (typeof key === 'symbol') {
                return undefined;
            }
            const cachehit = proxyGetterCache[key];
            if (cachehit) {
                return cachehit;
            }
            const r = new StateLinkImpl(
                this.state,
                this.path.slice().concat(key.toString()),
                this.onUpdateUsed,
                target[key]
            );
            if (this.disabledTracking) {
                r.disabledTracking = true;
            }
            proxyGetterCache[key] = r;
            return r;
        };
        return this.proxyWrap(this.valueUntracked as unknown as object, getter, o => {
            throw new StateLinkInvalidUsageError(o, this.path)
        }) as unknown as NestedInferredLink<S, E>;
    }

    private valueObjectImpl(): S {
        const getter = (target: object, key: PropertyKey) => {
            if (typeof key === 'symbol') {
                return undefined;
            }
            return (this.nested)![key].value;
        };
        return this.proxyWrap(this.valueUntracked as unknown as object, getter, o => {
            throw new StateLinkInvalidUsageError(o, this.path)
        }) as unknown as S;
    }

    // tslint:disable-next-line: no-any
    private proxyWrap(objectToWrap: any, getter: (target: any, key: PropertyKey) => any,
        onInvalidUsage: (op: string) => never
    ) {
        return new Proxy(objectToWrap, {
            getPrototypeOf: (target) => {
                return Object.getPrototypeOf(target);
            },
            setPrototypeOf: (target, v) => {
                return onInvalidUsage('setPrototypeOf')
            },
            isExtensible: (target) => {
                return false;
            },
            preventExtensions: (target) => {
                return onInvalidUsage('preventExtensions')
            },
            getOwnPropertyDescriptor: (target, p) => {
                const origin = Object.getOwnPropertyDescriptor(target, p);
                if (origin && Array.isArray(target) && p in Array.prototype) {
                    return origin;
                }
                return origin && {
                    configurable: true, // JSON.stringify() does not work for an object without it
                    enumerable: origin.enumerable,
                    get: () => getter(target as object, p),
                    set: undefined
                };
            },
            has: (target, p) => {
                if (typeof p === 'symbol') {
                    return false;
                }
                return p in target;
            },
            get: getter,
            set: (target, p, value, receiver) => {
                return onInvalidUsage('set')
            },
            deleteProperty: (target, p) => {
                return onInvalidUsage('deleteProperty')
            },
            defineProperty: (target, p, attributes) => {
                return onInvalidUsage('defineProperty')
            },
            enumerate: (target) => {
                if (Array.isArray(target)) {
                    return Object.keys(target).concat('length');
                }
                return Object.keys(target);
            },
            ownKeys: (target) => {
                if (Array.isArray(target)) {
                    return Object.keys(target).concat('length');
                }
                return Object.keys(target);
            },
            apply: (target, thisArg, argArray?) => {
                return onInvalidUsage('apply')
            },
            construct: (target, argArray, newTarget?) => {
                return onInvalidUsage('construct')
            }
        });
    }
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

function createState<S>(initial: S | (() => S)): State {
    let initialValue: S = initial as S;
    if (typeof initial === 'function') {
        initialValue = (initial as (() => S))();
    }
    return new State(initialValue);
}

function useSubscribedStateLink<S, E extends {}>(
    state: State,
    path: Path, update: () => void,
    subscribeTarget: Subscribable,
    disabledTracking?: boolean | undefined
) {
    const link = new StateLinkImpl<S, E>(
        state,
        path,
        update,
        state.get(path)
    );
    if (disabledTracking) {
        link.with(DisabledTracking)
    }
    useIsomorphicLayoutEffect(() => {
        subscribeTarget.subscribe(link);
        return () => subscribeTarget.unsubscribe(link);
    });
    return link;
}

function useGlobalStateLink<S, E>(stateLink: StateRefImpl<S, E>): StateLinkImpl<S, E> {
    const [, setValue] = React.useState({});
    return useSubscribedStateLink(stateLink.state, RootPath, () => {
        setValue({})
    }, stateLink.state, stateLink.disabledTracking);
}

function useLocalStateLink<S>(initialState: S | (() => S)): StateLinkImpl<S, {}> {
    const [value, setValue] = React.useState(() => ({ state: createState(initialState) }));
    return useSubscribedStateLink(value.state, RootPath, () => {
        setValue({ state: value.state })
    }, value.state);
}

function useDerivedStateLink<S, E extends {}>(originLink: StateLinkImpl<S, E>): StateLinkImpl<S, E> {
    const [, setValue] = React.useState({});
    return useSubscribedStateLink(originLink.state, originLink.path, () => {
        setValue({})
    }, originLink, originLink.disabledTracking);
    // note PrerenderTransform strategy is not inherited intentionally
}

function useAutoStateLink<S, E extends {}>(
    initialState: S | (() => S) | StateLink<S, E> | StateRef<S, E>
): StateLinkImpl<S, E> {
    if (initialState instanceof StateLinkImpl) {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return useDerivedStateLink(initialState as StateLinkImpl<S, E>);
    }
    if (initialState instanceof StateRefImpl) {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return useGlobalStateLink(initialState as StateRefImpl<S, E>);
    }

    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useLocalStateLink(initialState as S | (() => S)) as StateLinkImpl<S, E>;
}

function injectTransform<S, E extends {}, R>(
    link: StateLinkImpl<S, E>,
    transform: (state: StateLink<S, E>, prev: R | undefined) => R
) {
    let injectedOnUpdateUsed: (() => void) | undefined = undefined;
    const originOnUpdateUsed = link.onUpdateUsed;
    link.onUpdateUsed = () => {
        if (injectedOnUpdateUsed) {
            return injectedOnUpdateUsed();
        }
        return originOnUpdateUsed();
    }

    const result = transform(link, undefined);
    const prerenderEquals: ((a: R, b: R) => boolean) | undefined = link[PrerenderID];
    if (prerenderEquals === undefined) {
        return result;
    }

    injectedOnUpdateUsed = () => {
        // need to create new one to make sure
        // it does not pickup the stale cache of the original link after mutation
        const overidingLink = new StateLinkImpl<S, E>(
            link.state,
            link.path,
            link.onUpdateUsed,
            link.state.get(link.path)
        )
        // and we should inject to onUpdate now
        // so the overriding link is used to track used properties
        link.onSet = (s, p) => overidingLink.onSet(s, p);
        const updatedResult = transform(overidingLink, result);
        // if result is not changed, it does not affect the rendering result too
        // so, we skip triggering rerendering in this case
        if (!prerenderEquals(updatedResult, result)) {
            originOnUpdateUsed();
        }
    }
    return result;
}

///
/// EXPORTED IMPLEMENTATIONS
///

export function createStateLink<S>(initial: S | (() => S)): StateRef<S, {}> {
    return new StateRefImpl(createState(initial));
}

/*
 * Future docs for transformer
 * Forces rerender of a hooked component when result of `watcher`
 * is changed due to the change of the current value in `state`.
 * Change of the result is determined by the default tripple equality operator.
 * @param state state to watch for
 * @param watcher state-to-result redusing function. The second argument `prev` is
 * defined only when the `watcher` is invokded in reaction event after state is updated.
 * If the watcher returns the same value as the `prev`, the rerendering is not forced
 * by the watcher.
 */

export function useStateLink<S, E extends {}>(
    initialState: StateLink<S, E> | StateRef<S, E>
): StateLink<S, E>;
export function useStateLink<S, E extends {}, R>(
    initialState: StateLink<S, E> | StateRef<S, E>,
    transform: (state: StateLink<S, E>, prev: R | undefined) => R
): R;
export function useStateLink<S, E extends {}>(
    initialState: S | (() => S)
): StateLink<S, E>;
export function useStateLink<S, E extends {}, R>(
    initialState: S | (() => S),
    transform: (state: StateLink<S, E>, prev: R | undefined) => R
): R;
export function useStateLink<S, E extends {}, R>(
    initialState: S | (() => S) | StateLink<S, E> | StateRef<S, E>,
    transform?: (state: StateLink<S, E>, prev: R | undefined) => R
): R {
    const link = useAutoStateLink(initialState);
    if (transform) {
        return injectTransform(link, transform);
    }
    return link as unknown as R;
}

export function useStateLinkUnmounted<S, E extends {}>(
    stateRef: StateRef<S, E>,
): StateLink<S, E>;
export function useStateLinkUnmounted<S, E extends {}, R>(
    state: StateRef<S, E>,
    transform?: (state: StateLink<S, E>) => R
): R {
    const stateRef = state as StateRefImpl<S, E>;
    const link = new StateLinkImpl<S, E>(
        stateRef.state,
        RootPath,
        // it is assumed the client discards the state link once it is used
        () => {
            throw new Error('Internal Error: unexpected call');
        },
        stateRef.state.get(RootPath)
    ).with(DisabledTracking) // it does not matter how it is used, it is not subscribed anyway
    if (transform) {
        return transform(link);
    }
    return link as unknown as R;
}

// tslint:disable-next-line: function-name
export function DisabledTracking(): Plugin<{}, {}> {
    return {
        id: DisabledTrackingID,
        instanceFactory: () => ({
            extensions: [],
            extensionsFactory: () => ({})
        })
    }
}

export interface PrerenderExtensions {
    enablePrerender(equals?: (newValue: TransformResult, prevValue: TransformResult) => boolean): void;
}

// tslint:disable-next-line: function-name
export function Prerender<S, E extends {}>(marker: PluginTypeMarker<S, E>):
    Plugin<E, PrerenderExtensions> {

    function defaultEquals(a: TransformResult, b: TransformResult) {
        return a === b;
    }

    return {
        id: PrerenderID,
        instanceFactory: () => ({
            extensions: ['enablePrerender'],
            extensionsFactory: (l: StateLink<StateValueAtPath, E>) => ({
                enablePrerender: (equals) => {
                    l[PrerenderID] = equals || defaultEquals
                },
            })
        })
    }
}

export default useStateLink;