declare const imports: any;

const Me = imports.misc.extensionUtils.getCurrentExtension();

import * as Ecs from 'ecs';
import * as Lib from 'lib';
import * as Log from 'log';
import * as Rect from 'rectangle';

import { Entity } from 'ecs';
import { Rectangle } from './rectangle';
import { ShellWindow } from './window';
import { Ext } from './extension';

const { ORIENTATION_HORIZONTAL, orientation_as_str } = Lib;

export var FORK = 0;
export var WINDOW = 1;

const XPOS = 0;
const YPOS = 1;
const WIDTH = 2;
const HEIGHT = 3;

/**
 * The world containing all forks and their attached windows, which is responible for
 * handling all automatic tiling and reflowing as windows are moved, closed, and resized
 */
export class AutoTiler extends Ecs.World {

    toplevel: Map<String, [Entity, [number, number]]>;
    string_reps: Ecs.Storage<string>;
    forks: Ecs.Storage<TilingFork>;

    on_attach: (parent: Entity, child: Entity) => void

    constructor() {
        super();

        /// Maintains a list of top-level forks.
        this.toplevel = new Map();

        // Needed when we're storing the entities in a map, because JS limitations.
        this.string_reps = this.register_storage();

        /// The storage for holding all fork associations
        this.forks = this.register_storage();

        // The callback to execute when a window has been attached to a fork.
        this.on_attach = () => { };
    }

    /**
     * Attaches a `new` window to the fork which `onto` is attached to.
     */
    attach_window(onto_entity: Entity, new_entity: Entity): [Entity, TilingFork] | null {
        Log.debug(`attaching Window(${new_entity}) onto Window(${onto_entity})`);

        for (const [entity, fork] of this.forks.iter()) {
            if (fork.left.is_window(onto_entity)) {
                const node = TilingNode.window(new_entity);
                if (fork.right) {
                    const result = this.create_fork(fork.left, node);
                    fork.left = TilingNode.fork(result[0]);
                    Log.debug(`attached Fork(${result[0]}) to Fork(${entity}).left`);
                    result[1].set_parent(entity);
                    return this._attach(onto_entity, new_entity, this.on_attach, entity, fork, result);
                } else {
                    fork.right = node;
                    return this._attach(onto_entity, new_entity, this.on_attach, entity, fork, null);
                }
            } else if (fork.right && fork.right.is_window(onto_entity)) {
                const result = this.create_fork(fork.right, TilingNode.window(new_entity));
                fork.right = TilingNode.fork(result[0]);
                Log.debug(`attached Fork(${result[0]}) to Fork(${entity}).right`);
                result[1].set_parent(entity);
                return this._attach(onto_entity, new_entity, this.on_attach, entity, fork, result);
            }
        }

        return null;
    }

    /**
     * Assigns the callback to trigger when a window is attached to a fork
     */
    connect_on_attach(callback: (parent: Entity, child: Entity) => void): AutoTiler {
        this.on_attach = callback;
        return this;
    }

    /**
     * Creates a new fork entity in the world
     *
     * @return Entity
     */
    create_entity(): Entity {
        const entity = super.create_entity();
        this.string_reps.insert(entity, `${entity}`);
        return entity;
    }

    /**
     * Create a new fork, where the left portion is a window `Entity`
     *
     * @param {Entity} window
     * @return [Entity, TilingFork]
     */
    create_fork(left: TilingNode, right?: TilingNode | null): [Entity, TilingFork] {
        const entity = this.create_entity();
        const fork = new TilingFork(left, right ? right : null);
        this.forks.insert(entity, fork);
        return [entity, fork];
    }

    /**
     * Create a new top level fork
     */
    create_toplevel(window: Entity, id: [number, number]): [Entity, TilingFork] {
        const [entity, fork] = this.create_fork(TilingNode.window(window));
        this.string_reps.with(entity, (sid) => {
            fork.set_toplevel(this, entity, sid, id);
        });

        return [entity, fork];
    }

    /**
     * Deletes a fork entity from the world, performing any cleanup necessary
     */
    delete_entity(entity: Entity) {
        const fork = this.forks.remove(entity);
        if (fork && fork.is_toplevel) {
            const id = this.string_reps.get(entity);
            if (id) this.toplevel.delete(id);
        }

        super.delete_entity(entity);
    }

    /**
     * Detaches an entity from the a fork, re-arranging the fork's tree as necessary
     */
    detach(fork_entity: Entity, window: Entity): [Entity, TilingFork] | null {
        let reflow_fork = null;

        this.forks.with(fork_entity, (fork) => {
            Log.debug(`detaching Window(${window}) from Fork(${fork_entity})`);

            if (fork.left.is_window(window)) {
                if (fork.parent && fork.right) {
                    Log.debug(`detaching Fork(${fork_entity}) and holding Window(${fork.right.entity}) for reassignment`);
                    reflow_fork = [fork.parent, this.reassign_child_to_parent(fork_entity, fork.parent, fork.right)];
                } else if (fork.right) {
                    reflow_fork = [fork_entity, fork];
                    if (fork.right.kind == WINDOW) {
                        const detached = fork.right;
                        fork.left = detached;
                        fork.right = null;
                    } else {
                        this.reassign_children_to_parent(fork_entity, fork.right.entity, fork);
                    }
                } else {
                    Log.debug(`deleting childless and parentless Fork(${fork_entity})`);
                    this.delete_entity(fork_entity);
                }
            } else if (fork.right && fork.right.is_window(window)) {
                // Same as the `fork.left` branch.
                if (fork.parent) {
                    Log.debug(`detaching Fork(${fork_entity}) and holding Window(${fork.left.entity}) for reassignment`);
                    reflow_fork = [fork.parent, this.reassign_child_to_parent(fork_entity, fork.parent, fork.left)];
                } else {
                    reflow_fork = [fork_entity, fork];

                    if (fork.left.kind == FORK) {
                        this.reassign_children_to_parent(fork_entity, fork.left.entity, fork);
                    } else {
                        fork.right = null;
                    }
                }
            }
        });

        if (reflow_fork) {
            Log.debug(`reflowing Fork(${reflow_fork[0]})`);
        }

        return reflow_fork;
    }

    /**
     * Creates a string representation of every fork in the world; formatted for human consumption
     */
    display(fmt: string) {
        // NOTE: Display as flat array
        // for (const [entity, fork] of this.forks.iter()) {
        //     fmt += `fork (${entity}): ${fork.display('')}\n`;
        // }

        // NOTE: Display as hiearachy from toplevel forks
        for (const [entity, _] of this.toplevel.values()) {
            Log.debug(`displaying fork (${entity})`);
            const fork = this.forks.get(entity);

            fmt += ' ';
            if (fork) {
                fmt += this._display_fork(entity, fork, 1) + '\n';
            } else {
                fmt += `Fork(${entity}) Invalid\n`;
            }
        }

        return fmt;
    }

    /**
     * Finds the top level fork associated with the given entity
     */
    find_toplevel(id: [number, number]): Entity | null {
        for (const [entity, value] of this.toplevel.values()) {
            if (value[0] == id[0] && value[1] == id[1]) {
                return entity;
            }
        }

        return null;
    }

    /**
     * Grows a sibling a fork
     */
    grow_sibling(ext: Ext, fork_e: Entity, fork_c: TilingFork, is_left: boolean, movement: number, crect: Rectangle) {
        if (fork_c.area) {
            if (fork_c.is_horizontal()) {
                if ((movement & (Lib.MOVEMENT_DOWN | Lib.MOVEMENT_UP)) != 0) {
                    Log.debug(`growing Fork(${fork_e}) up/down`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 3);
                } else if (is_left) {
                    if ((movement & Lib.MOVEMENT_RIGHT) != 0) {
                        Log.debug(`growing left child of Fork(${fork_e}) from left to right`);
                        this.readjust_fork_ratio_by_left(ext, crect.width, fork_c, fork_c.area.width);
                    } else {
                        Log.debug(`growing left child of Fork(${fork_e}) from right to left`);
                        this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2);
                    }
                } else if ((movement & Lib.MOVEMENT_RIGHT) != 0) {
                    Log.debug(`growing right child of Fork(${fork_e}) from left to right`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2);
                } else {
                    Log.debug(`growing right child of Fork(${fork_e}) from right to left`);
                    this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.width);
                }
            } else {
                if ((movement & (Lib.MOVEMENT_LEFT | Lib.MOVEMENT_RIGHT)) != 0) {
                    Log.debug(`growing Fork(${fork_e}) left/right`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 2);
                } else if (is_left) {
                    if ((movement & Lib.MOVEMENT_DOWN) != 0) {
                        Log.debug(`growing left child of Fork(${fork_e}) from top to bottom`);
                        this.readjust_fork_ratio_by_left(ext, crect.height, fork_c, fork_c.area.height);
                    } else {
                        Log.debug(`growing left child of Fork(${fork_e}) from bottom to top`);
                        this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3);
                    }
                } else if ((movement & Lib.MOVEMENT_DOWN) != 0) {
                    Log.debug(`growing right child of Fork(${fork_e}) from top to bottom`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3);
                } else {
                    Log.debug(`growing right child of Fork(${fork_e}) from bottom to top`);
                    this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.height);
                }
            }
        }
    }

    * iter(entity: Entity, kind: number): IterableIterator<TilingNode> {
        let fork = this.forks.get(entity);
        let forks = new Array(2);

        while (fork) {
            if (fork.left.kind == FORK) {
                forks.push(this.forks.get(fork.left.entity));
            }

            if (kind == null || fork.left.kind == kind) {
                yield fork.left
            }

            if (fork.right) {
                if (fork.right.kind == FORK) {
                    forks.push(this.forks.get(fork.right.entity));
                }

                if (kind == null || fork.right.kind == kind) {
                  yield fork.right;
                }
            }

            fork = forks.pop();
        }
    }

    /**
     * Finds the largest window on a monitor + workspace
     */
    largest_window_on(ext: Ext, entity: Entity): ShellWindow | null {
        let largest_window = null;
        let largest_size = 0;

        for (const win of this.iter(entity, WINDOW)) {
            const window = ext.windows.get(win.entity);

            if (window) {
                const rect = window.rect();
                const size = rect.width * rect.height;
                if (size > largest_size) {
                    largest_size = size;
                    largest_window = window;
                }
            }
        }

        return largest_window;
    }

    /**
     * Reassigns the child of a fork to the parent
     */
    reassign_child_to_parent(child_entity: Entity, parent_entity: Entity, branch: TilingNode): TilingFork | null {
        Log.debug(`reassigning Fork(${child_entity}) to parent Fork(${parent_entity})`);
        const parent = this.forks.get(parent_entity);

        if (parent) {
            if (parent.left.is_fork(child_entity)) {
                parent.left = branch;
                Log.debug(`reassigned Fork(${parent_entity}).left to (${parent.left.entity})`);
            } else {
                parent.right = branch;
                Log.debug(`reassigned Fork(${parent_entity}).right to (${parent.right.entity})`);
            }

            this.reassign_sibling(branch, parent_entity);
            this.delete_entity(child_entity);
        }

        return parent
    }

    /**
     * Reassigns a sibling based on whether it is a fork or a window.
     *
     * - If the sibling is a fork, reassign the parent.
     * - If it is a window, simply call on_attach
     */
    reassign_sibling(sibling: TilingNode, parent: Entity) {
        (sibling.kind == FORK ? this.reassign_parent : this.on_attach)
            .call(this, parent, sibling.entity);
    }

    /**
     * Reassigns children of the child entity to the parent entity
     *
     * Each fork has a left and optional right child entity
     */
    reassign_children_to_parent(parent_entity: Entity, child_entity: Entity, p_fork: TilingFork) {
        Log.debug(`reassigning children of Fork(${child_entity}) to Fork(${parent_entity})`);

        const c_fork = this.forks.get(child_entity);

        if (c_fork) {
            p_fork.left = c_fork.left;
            p_fork.right = c_fork.right;

            this.reassign_sibling(p_fork.left, parent_entity);
            if (p_fork.right) this.reassign_sibling(p_fork.right, parent_entity);

            this.delete_entity(child_entity);
        } else {
            Log.error(`Fork(${child_entity}) does not exist`);
        }
    }

    /**
     * Reassigns a child to the given parent
     */
    reassign_parent(parent: Entity, child: Entity) {
        Log.debug(`assigning parent of Fork(${child}) to Fork(${parent})`);
        this.forks.with(child, (fork) => fork.set_parent(parent));
    }

    /**
     * Resizes the sibling of a fork
     */
    resize(ext: Ext, fork_e: Entity, win_e: Entity, movement: number, crect: Rectangle) {
        this.forks.with(fork_e, (fork_c) => {
            const is_left = fork_c.left.is_window(win_e);

            ((movement & Lib.MOVEMENT_SHRINK) != 0 ? this.shrink_sibling : this.grow_sibling)
                .call(this, ext, fork_e, fork_c, is_left, movement, crect);
        });
    }

    resize_parent(parent: TilingFork, child: TilingFork, is_left: boolean) {
        Log.debug(`before ratio: ${parent.ratio}; (${child.area} : ${parent.area})`);

        if (!child.area || !parent.area || child.area.eq(parent.area)) return;

        const measure = parent.is_horizontal() ? 2 : 3;
        parent.ratio = is_left
            ? child.area.array[measure] / parent.area.array[measure]
            : (parent.area.array[measure] - child.area.array[measure]) / parent.area.array[measure];

        Log.debug(`after ratio: ${parent.ratio}`);
    }

    /// Readjusts the division of space between the left and right siblings of a fork
    readjust_fork_ratio_by_left(ext: Ext, left_length: number, fork: TilingFork, fork_length: number) {
        if (fork.area) fork.set_ratio(left_length, fork_length).tile(this, ext, fork.area, fork.workspace);
    }

    /// Readjusts the division of space between the left and right siblings of a fork
    ///
    /// Determines the size of the left sibling based on the new length of the right sibling
    readjust_fork_ratio_by_right(ext: Ext, right_length: number, fork: TilingFork, fork_length: number) {
        this.readjust_fork_ratio_by_left(ext, fork_length - right_length, fork, fork_length);
    }

    resize_fork_in_direction(ext: Ext, child_e: Entity, child: TilingFork, is_left: boolean, consider_sibling: boolean, crect: Rectangle, measure: number) {
        Log.debug(`resizing fork in direction ${measure}: considering ${consider_sibling}`);
        if (child.area && child.area_left) {
            const original = new Rect.Rectangle([crect.x, crect.y, crect.width, crect.height]);
            let length = (measure == 2 ? crect.width : crect.height);

            if (consider_sibling) {
                length += is_left
                    ? child.area.array[measure] - child.area_left.array[measure]
                    : child.area_left.array[measure];
            }

            const shrinking = length < child.area.array[measure];
            Log.debug(`shrinking? ${shrinking}`);

            let done = false;
            while (child.parent && !done) {
                Log.debug(`length = ${length}`);
                const parent = this.forks.get(child.parent);
                if (parent && parent.area) {
                    if (parent.area.contains(original)) {
                        if (shrinking) {
                            Log.debug(`Fork(${child_e}) area before: ${child.area}`);
                            if (child.area) child.area.array[measure] = length;
                            Log.debug(`Fork(${child_e}) area after ${child.area}`);
                        } else {
                            Log.info("breaking");
                            if (child.area) child.area.array[measure] = length;
                            this.resize_parent(parent, child, parent.left.is_fork(child_e));
                            done = true;
                        }
                    } else if (shrinking) {
                        Log.info("breaking");
                        this.resize_parent(parent, child, parent.left.is_fork(child_e));
                        done = true;
                    } else {
                        Log.debug(`Fork(${child_e}) area before: ${child.area}`);
                        if (child.area) child.area.array[measure] = length;
                        parent.area.array[measure] = length;
                        Log.debug(`Fork(${child_e}) area after ${child.area}`);
                    }

                    this.resize_parent(parent, child, parent.left.is_fork(child_e));

                    child_e = child.parent;
                    child = parent;
                } else {
                    break
                }
            }

            child.tile(this, ext, child.area ? child.area : new Rect.Rectangle([0, 0, 0, 0]), child.workspace);
        }
    }

    /**
     * Shrinks the sibling of a fork, possibly shrinking the fork itself.
     */
    shrink_sibling(ext: Ext, fork_e: Entity, fork_c: TilingFork, is_left: boolean, movement: number, crect: Rectangle) {
        if (fork_c.area) {
            if (fork_c.is_horizontal()) {
                if ((movement & (Lib.MOVEMENT_DOWN | Lib.MOVEMENT_UP)) != 0) {
                    Log.debug(`shrinking Fork(${fork_e}) up/down`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 3);
                } else if (is_left) {
                    if ((movement & Lib.MOVEMENT_LEFT) != 0) {
                        Log.debug(`shrinking left child of Fork(${fork_e}) from right to left`);
                        this.readjust_fork_ratio_by_left(ext, crect.width, fork_c, fork_c.area.array[2]);
                    } else {
                        Log.debug(`shrinking left child of Fork(${fork_e}) from left to right`);
                        this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2);
                    }
                } else if ((movement & Lib.MOVEMENT_LEFT) != 0) {
                    Log.debug(`shrinking right child of Fork(${fork_e}) from right to left`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 2);
                } else {
                    Log.debug(`shrinking right child of Fork(${fork_e}) from left to right`);
                    this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.array[2]);
                }
            } else {
                if ((movement & (Lib.MOVEMENT_LEFT | Lib.MOVEMENT_RIGHT)) != 0) {
                    Log.debug(`shrinking Fork(${fork_e}) left/right`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, false, crect, 2);
                } else if (is_left) {
                    if ((movement & Lib.MOVEMENT_UP) != 0) {
                        Log.debug(`shrinking left child of Fork(${fork_e}) from bottom to top`);
                        this.readjust_fork_ratio_by_left(ext, crect.height, fork_c, fork_c.area.array[3]);
                    } else {
                        Log.debug(`shrinking left child of Fork(${fork_e}) from top to bottom`);
                        this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3);
                    }
                } else if ((movement & Lib.MOVEMENT_UP) != 0) {
                    Log.debug(`shrinking right child of Fork(${fork_e}) from bottom to top`);
                    this.resize_fork_in_direction(ext, fork_e, fork_c, is_left, true, crect, 3);
                } else {
                    Log.debug(`shrinking right child of Fork(${fork_e}) from top to bottom`);
                    this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.array[3]);
                }
            }
        }
    }

    _attach(
        onto_entity: Entity,
        new_entity: Entity,
        assoc: (a: Entity, b: Entity) => void,
        entity: Entity,
        fork: TilingFork,
        result: [Entity, TilingFork] | null
    ): [Entity, TilingFork] | null {
        if (result) {
            assoc(result[0], onto_entity);
            assoc(result[0], new_entity);
            return result;
        } else {
            assoc(entity, new_entity);
            return [entity, fork];
        }
    }

    _display_branch(branch: TilingNode, scope: number): string {
        if (branch.kind == WINDOW) {
            return `Window(${branch.entity})`;
        } else {
            const fork = this.forks.get(branch.entity);
            return fork ? this._display_fork(branch.entity, fork, scope + 1) : "Missing Fork";
        }
    }

    _display_fork(entity: Entity, fork: TilingFork, scope: number): string {
        let fmt = `Fork(${entity}) [${fork.area ? fork.area.array : "unknown"}]: {\n`;

        fmt += ' '.repeat((1 + scope) * 2) + `workspace: (${fork.workspace}),\n`;
        fmt += ' '.repeat((1 + scope) * 2) + 'left:  ' + this._display_branch(fork.left, scope) + ',\n';

        if (fork.right) {
            fmt += ' '.repeat((1 + scope) * 2) + 'right: ' + this._display_branch(fork.right, scope) + ',\n';
        }

        fmt += ' '.repeat(scope * 2) + '}';
        return fmt;
    }
}

/// A node within the `AutoTiler`, which may contain either windows and/or sub-forks.
export class TilingFork {
    left: TilingNode;
    right: TilingNode | null;
    area: Rectangle | null;
    area_left: Rectangle | null;
    parent: Entity | null;
    workspace: number | null;
    ratio: number;
    orientation: number;
    is_toplevel: boolean;

    constructor(left: TilingNode, right: TilingNode | null) {
        this.left = left;
        this.right = right;
        this.area = null;
        this.area_left = null;
        this.parent = null;
        this.workspace = null;
        this.ratio = .5;
        this.orientation = ORIENTATION_HORIZONTAL;
        this.is_toplevel = false;
    }

    display(fmt: string) {
        fmt += `{\n  parent: ${this.parent},`;

        if (this.area) {
            fmt += `\n  area: (${this.area.array}),`;
        }

        if (this.workspace) {
            fmt += `\n  workspace: (${this.workspace}),`;
        }

        if (this.left) {
            fmt += `\n  left: ${this.left.display('')},`;
        }

        if (this.right) {
            fmt += `\n  right: ${this.right.display('')},`;
        }

        fmt += `\n  orientation: ${orientation_as_str(this.orientation)}\n}`;
        return fmt;
    }

    is_horizontal(): boolean {
        return ORIENTATION_HORIZONTAL == this.orientation;
    }

    /// Replaces the association of a window in a fork with another
    replace_window(a: Entity, b: Entity): boolean {
        if (this.left.is_window(a)) {
            this.left.entity = b;
        } else if (this.right) {
            this.right.entity = b;
        } else {
            return false;
        }

        return true;
    }

    set_orientation(orientation: number): TilingFork {
        this.orientation = orientation;
        return this;
    }

    set_parent(parent: Entity): TilingFork {
        this.parent = parent;
        return this;
    }

    set_ratio(left_length: number, fork_length: number): TilingFork {
        this.ratio = left_length / fork_length;
        Log.debug(`new ratio: ${this.ratio}`);
        return this;
    }

    set_toplevel(tiler: AutoTiler, entity: Entity, string: string, id: [number, number]): TilingFork {
        this.is_toplevel = true;
        tiler.toplevel.set(string, [entity, id]);
        return this;
    }

    /// Tiles all windows within this fork into the given area
    tile(tiler: AutoTiler, ext: Ext, area: Rectangle, workspace: number | null) {
        /// Memorize our area for future tile reflows

        if (null == this.area && null == this.parent) {
            this.area = new Rect.Rectangle([
                area.x + ext.gap_outer,
                area.y + ext.gap_outer,
                area.width - ext.gap_outer * 2,
                area.height - ext.gap_outer * 2,
            ]);
        } else {
            this.area = area.clone();
        }

        this.workspace = workspace;

        if (this.right) {
            const [l, p] = ORIENTATION_HORIZONTAL == this.orientation
                ? [WIDTH, XPOS] : [HEIGHT, YPOS];

            const length = Math.round(area.array[l] * this.ratio);


            let region = this.area.clone();
            Log.debug(`this.area: ${this.area.array}`);
            Log.debug(`region: ${region.array}`);

            region.array[l] = length - ext.gap_inner_half;

            this.area_left = region.clone();
            this.left.tile(tiler, ext, region, workspace);

            region.array[p] = region.array[p] + length + ext.gap_inner;
            region.array[l] = this.area.array[l] - length - ext.gap_inner;

            Log.debug(`this.area: ${this.area.array}`);
            Log.debug(`region: ${region.array}`);
            this.right.tile(tiler, ext, region, workspace);
        } else {
            this.left.tile(tiler, ext, this.area, workspace);
            this.area_left = this.area;
        }
    }

    toggle_orientation() {
        this.orientation = Lib.ORIENTATION_HORIZONTAL == this.orientation
            ? Lib.ORIENTATION_VERTICAL
            : Lib.ORIENTATION_HORIZONTAL;
    }
}

/// A tiling node may either refer to a window entity, or another fork entity.
export class TilingNode {
    kind: number;
    entity: Entity;

    constructor(kind: number, entity: Entity) {
        this.kind = kind;
        this.entity = entity;
    }

    /**
     * Create a fork variant of a `TilingNode`
     *
     * @param {TilingFork} fork
     *
     * @return TilingNode
     */
    static fork(fork: Entity): TilingNode {
        return new TilingNode(FORK, fork);
    }

    /**
     * Create the window variant of a `TilingNode`
     */
    static window(window: Entity): TilingNode {
        return new TilingNode(WINDOW, window);
    }

    display(fmt: string) {
        fmt += `{\n    kind: ${node_variant_as_string(this.kind)},\n    entity: (${this.entity})\n  }`;
        return fmt;
    }

    /**
     * Asks if this fork is the fork we are looking for
     */
    is_fork(entity: Entity): boolean {
        return FORK == this.kind && Ecs.entity_eq(this.entity, entity);
    }

    /**
     * Asks if this window is the window we are looking for
     */
    is_window(entity: Entity): boolean {
        return WINDOW == this.kind && Ecs.entity_eq(this.entity, entity);
    }

    /**
     * Tiles all windows associated with this node
     */
    tile(tiler: AutoTiler, ext: Ext, area: Rectangle, workspace: number | null) {
        if (FORK == this.kind) {
            Log.debug(`tiling Fork(${this.entity}) into [${area.array}]`);
            const fork = tiler.forks.get(this.entity);
            if (fork) fork.tile(tiler, ext, area, workspace);
        } else {
            Log.debug(`tiling Window(${this.entity}) into [${area.array}]`);
            const window = ext.windows.get(this.entity);

            if (window) {
                window.move(area);

                window.meta.change_workspace_by_index(workspace, false);
            }
        }
    }
}

function node_variant_as_string(value: number): string {
    return value == FORK ? "NodeVariant::Fork" : "NodeVariant::Window";
}
