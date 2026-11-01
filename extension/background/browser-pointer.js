import { executeFrameScript, withBrowserFrameContext } from './browser-frames.js';
import { runBrowserPageCommand } from './browser-page.js';
import { validateBrowserAxReference } from './browser-ax.js';
const fail = (code, message) => Object.assign(new Error(message), { code });
const sourceKey = source => source.sessionId || '';
// Project a viewport point through a CSS-transformed iframe content quad.
// A homography also handles perspective; adding bounding-box offsets does not.
export function projectFramePoint(point, size, quad) {
    if (!size || ![size.width, size.height].every(n => Number.isFinite(n) && n > 0) || !Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite))
        throw fail('POINTER_GEOMETRY_UNAVAILABLE', 'Frame geometry is unavailable.');
    const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-6)
        throw fail('POINTER_GEOMETRY_UNAVAILABLE', 'The frame has degenerate geometry.');
    const g = (dx3 * dy2 - dx2 * dy3) / determinant, h = (dx1 * dy3 - dx3 * dy1) / determinant;
    const u = point.x / size.width, v = point.y / size.height, denominator = g * u + h * v + 1;
    if (![u, v, denominator].every(Number.isFinite) || u < 0 || v < 0 || u > 1 || v > 1 || Math.abs(denominator) < 1e-6)
        throw fail('ELEMENT_OFFSCREEN', 'The target is outside its frame viewport.');
    return { x: ((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / denominator,
        y: ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / denominator };
}
export function unprojectFramePoint(point, size, quad) {
    projectFramePoint({ x: 0, y: 0 }, size, quad); // Validate dimensions and non-degenerate geometry.
    const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    const det = dx1 * dy2 - dx2 * dy1, g = (dx3 * dy2 - dx2 * dy3) / det, h = (dx1 * dy3 - dx3 * dy1) / det;
    const a = x1 - x0 + g * x1 - point.x * g, b = x3 - x0 + h * x3 - point.x * h, c = point.x - x0;
    const d = y1 - y0 + g * y1 - point.y * g, e = y3 - y0 + h * y3 - point.y * h, f = point.y - y0;
    const denominator = a * e - b * d;
    const result = { x: (c * e - b * f) / denominator * size.width, y: (a * f - c * d) / denominator * size.height };
    if (![result.x, result.y].every(Number.isFinite))
        throw fail('POINTER_GEOMETRY_UNAVAILABLE', 'Frame coordinates cannot be inverted.');
    return result;
}
function center(quad, viewport) {
    let points = quad.reduce((all, _, i) => i % 2 ? all : [...all, { x: quad[i], y: quad[i + 1] }], []);
    // Clip rotated/partially visible quads before selecting an interior point.
    for (const [axis, edge, sign] of [['x', 0, 1], ['x', viewport.width, -1], ['y', 0, 1], ['y', viewport.height, -1]]) {
        const clipped = [];
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length], insideA = sign * (a[axis] - edge) >= 0, insideB = sign * (b[axis] - edge) >= 0;
            if (insideA)
                clipped.push(a);
            if (insideA !== insideB) {
                const t = (edge - a[axis]) / (b[axis] - a[axis]);
                clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            }
        }
        points = clipped;
    }
    const area = Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a.x * b.y - a.y * b.x; }, 0)) / 2;
    return area > 1 ? { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length } : null;
}
export async function executeFramePointer(chrome, tabId, command, args, ensureCdpAttached, control = {}) {
    return withBrowserFrameContext(chrome, tabId, args, ensureCdpAttached, async ({ isolated, selected, state }) => {
        const send = (source, method, params) => chrome.debugger.sendCommand(source, method, params);
        const root = { tabId }, tokens = [], objects = [], deadline = Date.now() + 30000;
        const selectedArgs = { ...args, frameId: selected.frameId, documentId: selected.documentId };
        const checkContext = () => {
            control.assertRunning?.();
            if (Date.now() > deadline)
                throw fail('POINTER_OPERATION_INTERRUPTED', 'Pointer preparation exceeded its deadline. Inspect the page before retrying; earlier hover or click effects may have happened.');
            if (![...state.contexts.values()].some(item => item.uniqueId === isolated.uniqueId && sourceKey(item.source) === sourceKey(isolated.source)))
                throw fail('FRAME_DOCUMENT_CHANGED', 'The target document changed. Inspect the page before retrying any action.');
        };
        const viewport = async (source, frameId) => {
            const { executionContextId } = await send(source, 'Page.createIsolatedWorld', { frameId, worldName: 'weworker-browser-pointer' });
            const world = state.contexts.get(`${sourceKey(source)}:${executionContextId}`);
            if (!world?.uniqueId || world.auxData?.frameId !== frameId)
                throw fail('FRAME_CONTEXT_UNAVAILABLE', 'Frame viewport identity is unavailable.');
            const result = await send(source, 'Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', uniqueContextId: world.uniqueId, returnByValue: true });
            if (result.exceptionDetails || !result.result?.value)
                throw fail('FRAME_CONTEXT_UNAVAILABLE', 'Frame viewport is unavailable.');
            return { size: result.result.value, world };
        };
        const node = async (input) => {
            const pointerToken = `__weworkerPointer_${crypto.randomUUID().replaceAll('-', '')}`;
            tokens.push(pointerToken);
            const result = await executeFrameScript(chrome, tabId, selectedArgs, runBrowserPageCommand, ['bounds', { ...input, pointerToken }]);
            if (!result.result?.ok)
                throw fail(result.result?.error?.code || 'ELEMENT_NOT_FOUND', result.result?.error?.message || 'Target is unavailable.');
            checkContext();
            const object = await send(isolated.source, 'Runtime.evaluate', { expression: `globalThis[${JSON.stringify(pointerToken)}]`, uniqueContextId: isolated.uniqueId });
            if (!object.result?.objectId)
                throw fail('FRAME_DOCUMENT_CHANGED', 'The selected target no longer exists.');
            objects.push({ source: isolated.source, objectId: object.result.objectId });
            return object.result.objectId;
        };
        const point = async (objectId) => {
            checkContext();
            const trees = new Map(), frames = new Map(), worlds = new Map();
            const frame = async (id, source) => {
                if (!trees.has(sourceKey(source))) {
                    const { frameTree } = await send(source, 'Page.getFrameTree');
                    trees.set(sourceKey(source), frameTree.frame.id);
                    const visit = (item, parentId) => { frames.set(`${sourceKey(source)}:${item.frame.id}`, { ...item.frame, parentId: item.frame.parentId || parentId, source }); for (const child of item.childFrames || [])
                        visit(child, item.frame.id); };
                    visit(frameTree);
                }
                const found = frames.get(`${sourceKey(source)}:${id}`);
                if (!found)
                    throw fail('FRAME_DOCUMENT_CHANGED', 'The frame ancestry changed.');
                return found;
            };
            const info = async (id) => {
                if (worlds.has(id))
                    return worlds.get(id);
                const candidates = [...state.contexts.values()].filter(item => item.auxData?.isDefault && item.auxData.frameId === id);
                if (candidates.length !== 1)
                    throw fail('FRAME_CONTEXT_UNAVAILABLE', 'Frame ancestry identity is unavailable.');
                const source = candidates[0].source, data = { ...await frame(id, source), ...await viewport(source, id) };
                worlds.set(id, data);
                return data;
            };
            const local = async (data, position) => {
                if (trees.get(sourceKey(data.source)) === data.id)
                    return position;
                const owner = await send(data.source, 'DOM.getFrameOwner', { frameId: data.id });
                const { model } = await send(data.source, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
                return unprojectFramePoint(position, data.size, model.content);
            };
            const inViewport = (position, size) => { if (position.x < 0 || position.y < 0 || position.x >= size.width || position.y >= size.height)
                throw fail('ELEMENT_OFFSCREEN', 'The target or an ancestor is outside the viewport.'); };
            const hitTest = async (source, objectId, position) => {
                const hit = await send(source, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(x,y){ if(!this.isConnected)return false;let target=this,root=target.getRootNode();while(root instanceof ShadowRoot){const hit=root.elementFromPoint(x,y);if(!hit||(hit!==target&&!target.contains(hit)))return false;target=root.host;root=target.getRootNode();}const hit=this.ownerDocument.elementFromPoint(x,y);return !!hit&&(hit===target||target.contains(hit)); }', arguments: [{ value: position.x }, { value: position.y }], returnByValue: true });
                if (hit.result?.value !== true)
                    throw fail('ELEMENT_OBSCURED', 'The target or an ancestor frame is covered by another element.');
            };
            const source = isolated.source, currentInfo = await info(isolated.auxData.frameId);
            const rootInfo = await info(trees.get(sourceKey(source)));
            const { quads } = await send(source, 'DOM.getContentQuads', { objectId });
            let position = quads?.map(quad => center(quad, rootInfo.size)).find(Boolean);
            if (!position)
                throw fail('ELEMENT_OFFSCREEN', 'No visible target area remains.');
            position = await local(currentInfo, position);
            inViewport(position, currentInfo.size);
            await hitTest(source, objectId, position);
            let current = currentInfo;
            const visited = new Set();
            while (current.parentId) {
                if (visited.has(current.id))
                    throw fail('FRAME_DOCUMENT_CHANGED', 'Frame ancestry contains a cycle.');
                visited.add(current.id);
                const parent = await info(current.parentId);
                const owner = await send(parent.source, 'DOM.getFrameOwner', { frameId: current.id });
                const { model } = await send(parent.source, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
                position = await local(parent, projectFramePoint(position, current.size, model.content));
                inViewport(position, parent.size);
                const resolved = await send(parent.source, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: parent.world.id });
                objects.push({ source: parent.source, objectId: resolved.object.objectId });
                await hitTest(parent.source, resolved.object.objectId, position);
                current = parent;
            }
            for (const { world, source } of worlds.values())
                if (state.contexts.get(`${sourceKey(source)}:${world.id}`)?.uniqueId !== world.uniqueId)
                    throw fail('FRAME_DOCUMENT_CHANGED', 'An ancestor document changed before dispatch.');
            checkContext();
            return position;
        };
        try {
            await send(root, 'Page.bringToFront');
            if (control.objectId && control.contextId !== isolated.uniqueId) throw fail('FRAME_DOCUMENT_CHANGED', 'The retained query target belongs to another document.');
            const fromNode = control.objectId || await node(selectedArgs);
            // Scroll the retained backend node through same-process and remote ancestors.
            await send(isolated.source, 'DOM.scrollIntoViewIfNeeded', { objectId: fromNode });
            const toNode = command === 'drag' ? await node({ ...selectedArgs, selector: args.toSelector, scrollIntoView: false }) : null;
            const from = await point(fromNode), to = toNode ? await point(toNode) : null;
            const mouse = params => {
                // Always release a pressed button, even after navigation/deadline.
                if (params.type !== 'mouseReleased') checkContext();
                return send(root, 'Input.dispatchMouseEvent', params);
            };
            await control.beforeDispatch?.();
            await mouse({ type: 'mouseMoved', ...from });
            if (command === 'hover')
                return { action: command, completed: true, trusted: true, frameId: selected.frameId, documentId: selected.documentId };
            const stable = async () => {
                const next = await point(fromNode);
                if (Math.hypot(next.x - from.x, next.y - from.y) > 0.5)
                    throw fail('POINTER_TARGET_CHANGED', 'The target moved after hovering. Inspect the page before clicking again.');
                if (toNode) {
                    const nextTo = await point(toNode);
                    if (Math.hypot(nextTo.x - to.x, nextTo.y - to.y) > 0.5)
                        throw fail('POINTER_TARGET_CHANGED', 'The drag destination moved.');
                }
            };
            for (let count = 1; count <= (command === 'dblclick' ? 2 : 1); count++) {
                await stable();
                await control.beforeDispatch?.();
                if (typeof args.ref === 'string' && args.ref.startsWith('ax:'))
                    await validateBrowserAxReference(chrome, tabId, selectedArgs, ensureCdpAttached, command);
                if (typeof args.ref === 'string' && args.ref.startsWith('shadow:')) {
                    const checked = await executeFrameScript(chrome, tabId, selectedArgs, runBrowserPageCommand, ['bounds', { ...selectedArgs, scrollIntoView: false, pointerToken: tokens[0] }]);
                    if (!checked.result?.ok) throw fail(checked.result?.error?.code || 'STALE_REF', checked.result?.error?.message || 'Shadow reference changed after hover.');
                }
                checkContext();
                let releaseAt = from;
                try {
                    await control.beforePress?.();
                    checkContext();
                    await mouse({ type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: count });
                    if (to)
                        for (let i = 1; i <= 10; i++) {
                            checkContext();
                            const next = { x: from.x + (to.x - from.x) * i / 10, y: from.y + (to.y - from.y) * i / 10 };
                            await mouse({ type: 'mouseMoved', ...next, button: 'left', buttons: 1 });
                            releaseAt = next;
                        }
                }
                finally {
                    await mouse({ type: 'mouseReleased', ...releaseAt, button: 'left', buttons: 0, clickCount: count });
                }
            }
            return { action: command, completed: true, trusted: true, frameId: selected.frameId, documentId: selected.documentId };
        }
        catch (error) {
            if (error.code)
                throw error;
            throw fail('POINTER_OPERATION_INTERRUPTED', 'Native pointer execution was interrupted. Its side effects may have happened; inspect state before retrying.');
        }
        finally {
            try {
                await executeFrameScript(chrome, tabId, selectedArgs, function (names) { for (const name of names)
                    delete globalThis[name]; }, [tokens]);
            }
            catch { }
            for (const object of objects)
                try {
                    await send(object.source, 'Runtime.releaseObject', { objectId: object.objectId });
                }
                catch { }
        }
    });
}
