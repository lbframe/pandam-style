/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the PERSISTENT COVERAGE GRAPH (Spike 4, Phase D1).
 *
 * WHAT THIS IS
 *
 * The state that answers "which files are under the declared roots, why, and
 * through which edge", kept across revisions. It is owned, compact data: a
 * module node, its forward local edges, its reverse local edges, its root
 * membership, its covered state, its coverage origin, its unresolved edges, its
 * external requests, its relay edges, and a graph revision. No Babel `NodePath`,
 * no AST, and no reference into a parse a later transform is free to rewrite -
 * the same rule the module summary follows, for the same reason.
 *
 * WHY IT EXISTS
 *
 * Phase A made discovery O(declared). Phase B made an undeclared mutation
 * observable. Phase C took the project-wide coverage array off the agent's
 * result. What was left was still O(project) every revision: the closure was
 * re-walked from the roots over every covered file and every edge. The Phase D
 * baseline is the number that makes the fix decidable - at c10000 a one-file
 * agent edit spent 103.7ms of its 175.9ms inside `refreshClosure`, 59% of the
 * whole diagnostics interval, walking ten thousand modules to discover that
 * their edges had not moved. The same pass is 33% of the interval at c1000, so
 * the cost grows with the project: it is structural, and it is neither the parse
 * (the summaries were already reused) nor the reuse loop (timed separately, and
 * separately small).
 *
 * THE ONE RULE THAT MAKES IT CORRECT
 *
 *     incrementalClosure(revision N) == freshClosure(revision N)
 *
 * for the covered set, the coverage origins, the CANONICAL ORDER, the
 * unresolved edges, the external requests, the relay edges and the coverage
 * diagnostics. Not "the same files, in some order": Spike 2 and Spike 3
 * established that the coverage array, the CSS contribution order and the
 * cascade output are all functions of the iteration order of the covered map,
 * so a faster traversal that visited the same files in a different order would
 * emit a differently ordered stylesheet. That is the most expensive way this
 * file could be fast, which is why the ordering model is stated separately from
 * the reachability model and is not traded away.
 *
 * THE REACHABILITY MODEL, AND WHY IT IS A SET
 *
 * A node's `support` is the SET OF DECLARED ROOTS THAT REACH IT:
 *
 *     support(N) = rootIds(N)  U  { support(P) : P is a covered parent of N }
 *
 * and N is covered exactly when that set is non-empty.
 *
 * The counter is the obvious encoding and it is wrong at scale: a chain of k
 * diamonds doubles the count at every level, so ordinary sharing needs a bigint
 * at a thousand files and overflows one at a hundred thousand. The set is
 * bounded by the number of declared roots - a number a human wrote in a config -
 * and it answers the only question coverage asks, "is this node reachable from
 * a root at all?", exactly.
 *
 * The consequence the model exists to get right: `A -> C` and `B -> C` means C
 * derives one support entry from A and the same one from B, and C is ONE node.
 * When A disappears, C's support is RE-DERIVED from the parents that remain, so
 * C stays covered through B. Deleting A's old subtree blindly - which is what
 * "remove the file and everything under it" would do - gets that wrong, and it
 * is the easiest mistake in this file to make.
 *
 * THE ORDERING MODEL, AND ITS ONE HONEST LIMITATION
 *
 * The canonical order is the order `collectCoveredFiles` produces: every root
 * file in the order its root's walk produced it, then every non-root covered
 * file in the order the queue discipline first reached it, with the same
 * last-in-first-out queue, the same edge order inside a file, and the same
 * first-coverage-wins rule.
 *
 * That order is a DEPTH-FIRST PRE-DISCOVERY order, and a DFS pre-order is not
 * locally incrementally maintainable in general: two different edge sets over the
 * same node set can discover those nodes in two different orders, and no bounded
 * local rule says which. So the file draws the line where the mathematics draws
 * it.
 *
 *   no graph mutation   the order is unchanged, provably, at ZERO nodes visited
 *   a graph mutation    the order is re-derived by `materialise`, which is the
 *                       SAME traversal a cold build performs over data that is
 *                       already in memory: no read, no parse, no resolution
 *                       probe, no coverage record allocated from a scan. The
 *                       fact is counted as `closure_full_walk`.
 *
 * The style-only edit an AI agent performs thousands of times a day takes the
 * first branch and visits no node at all. A module add, a rename or a re-export
 * edit takes the second, and is counted and labelled rather than dressed up as
 * O(affected). Claiming the second branch was O(affected) would be a claim that
 * survives until somebody diffs a stylesheet.
 *
 * WHAT A NODE'S DEPARTURE DOES TO THE INDEXES
 *
 * A node that no declared root reaches any more is DELETED, with its forward
 * edges, its reverse index entries, its support set and its root membership.
 * That is what keeps the graph proportional to the CURRENT project rather than
 * to everything the session has ever seen, and it is safe because a node can
 * only become covered again through an EDGE, and an edge only appears when the
 * file that owns it is examined - so the return always arrives with the
 * examination that caused it, and the node is re-derived then.
 *
 * The one node that survives its own file is a file that is gone AND still
 * named by a covered edge. It stays as an unreadable stub with no edges, because
 * that is what produces the `<unparseable>` coverage gap the full rebuild
 * produces, and a stub that reported a different answer would break the oracle
 * for the case it exists to describe.
 *
 * FALLBACKS, NAMED
 *
 *   roots              the declared roots changed. Coverage under different roots
 *                      is not a delta of anything, so the graph is rebuilt and
 *                      `closure_full_fallback` is set with reason `roots`.
 *   full-discovery     the caller could not describe its mutation completely,
 *                      so nothing in the previous graph can be trusted to still
 *                      be there. The whole graph is rebuilt.
   first-revision     there is no previous graph. Not a degraded answer - the
 *                      cold build is the reference - but counted, because a
 *                      metric that is zero on the cold build and zero on a
 *                      style edit and never non-zero is not measuring the
 *                      difference between them.
 */

import * as path from 'path';

/**
 * A support cascade that has not settled after this many node visits is
 * reported as aborted and the closure falls back to the canonical traversal's
 * own answer.
 *
 * It exists so a pathological project degrades to a counted re-derivation
 * instead of an unbounded loop. It is unreachable for an acyclic module graph,
 * which every real one is: a cycle in an import graph is a cycle in the
 * program's initialisation order.
 */
const PROPAGATION_VISIT_LIMIT = 4000000;

function nowNs() {
  return Number(process.hrtime.bigint());
}

/**
 * The graph mutation one revision produced.
 *
 * Recorded rather than inferred, because "which nodes entered coverage" is a
 * question the next revision depends on and a number nobody can reconstruct
 * after the fact is not an answer.
 */
function emptyDelta() {
  return {
    nodesAdded: [],
    nodesRemoved: [],
    edgesAdded: 0,
    edgesRemoved: 0,
    edgesRetargeted: 0,
    nodesEnteringCoverage: [],
    nodesLeavingCoverage: [],
    rootsEntered: [],
    rootsLeft: [],
    unresolvedEdgesAdded: 0,
    unresolvedEdgesResolved: 0,
    filesExamined: 0,
    reachabilityUpdates: 0,
    nodesPruned: 0,
    setDivergence: 0,
    propagationAborted: false,
    /** An edge set changed, so the discovery order cannot be assumed. */
    edgeSetChanged: false,
  };
}

/**
 * An edge the graph owns.
 *
 * The summary's facts plus the resolution DERIVED at this revision. Resolution
 * is a property of the filesystem at a revision, not of the source, so it lives
 * beside the edge and is diffed against the previous revision's answer - which
 * is how "this import used to resolve and now does not" becomes a graph
 * mutation instead of a silent difference.
 */
function ownedEdge(edge, resolved) {
  return {
    request: edge.request,
    form: edge.form,
    local: edge.local === true,
    isStylesheet: edge.isStylesheet === true,
    resource: edge.resource === true,
    computed: edge.computed === true,
    line: edge.line ?? null,
    resolved,
  };
}

function sameEdge(a, b) {
  return (
    a.request === b.request &&
    a.form === b.form &&
    a.local === b.local &&
    a.isStylesheet === b.isStylesheet &&
    a.resource === b.resource &&
    a.computed === b.computed &&
    a.line === b.line &&
    a.resolved === b.resolved
  );
}

/**
 * The identity of an edge inside its file.
 *
 * A static edge has a request, and the request IS its identity: two edges with
 * the same request in one file are one edge for coverage purposes, because
 * coverage only ever records the request. A computed dynamic import has a null
 * request, and the only thing that distinguishes it from another is where it
 * sits in the file, so it is keyed by position.
 */
function edgeKey(edge, index) {
  return edge.request == null ? `computed:${index}` : edge.request;
}

function newNode(file) {
  return {
    file,
    /** The declared roots whose walk listed this file. Empty for a non-root. */
    rootIds: new Set(),
    /** The nodes with a live edge into this one. A covered parent, or not. */
    parents: new Set(),
    /** The declared roots that reach this file. Empty means not covered. */
    support: new Set(),
    covered: false,
    origin: null,
    edges: [],
    /** Parser coordinates when source bytes exist but cannot be parsed. */
    parseLocation: null,
    /** False until the node's outgoing edges have been derived once. */
    derived: false,
    unreadable: false,
    importSources: [],
  };
}

/** The distinct resolved targets of a node's live edges, in edge order. */
function childrenOf(node) {
  const out = [];
  for (const edge of node.edges) {
    if (edge.resolved == null) continue;
    if (out.includes(edge.resolved)) continue;
    out.push(edge.resolved);
  }
  return out;
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * The persistent coverage graph.
 *
 * `rootFiles` is the cached answer to "which files are under this root", one
 * array per walked root directory, in the exact order `walkFiles` produced. It
 * is owned HERE rather than by the session because it is the graph's root
 * membership on disk: a file that appeared or disappeared re-reads one directory
 * and every other root's list is reused verbatim.
 *
 * `closure` is the materialised answer of the last revision - the covered map in
 * CANONICAL ORDER and the three ordered record lists that are functions of the
 * same traversal. A revision that changes nothing in the graph returns THE SAME
 * OBJECT, which is the point: returning a fresh one is what a project-sized
 * rebuild costs.
 */
export function createCoverageGraph() {
  return {
    roots: null,
    rootFiles: new Map(),
    nodes: new Map(),
    closure: null,
    revision: 0,
    fullFallback: false,
    fullFallbackReason: null,
  };
}

// ------------------------------------------------------------ root seeding ---

/**
 * The roots, in order, each with the files its walk produced.
 *
 * A file whose CONTENT changed is not in the refresh set at all: its path, its
 * position among its neighbours and its neighbours are all unchanged, and there
 * is nothing to re-derive. That is the one-file agent edit, and it costs no
 * directory read whatsoever.
 *
 * A file that APPEARED or DISAPPEARED does change the order a walk would
 * produce, so its parent directory is re-read - one `readdir` of one directory,
 * not a walk of the tree. In the pathological shape of a project with ten
 * thousand files in one directory that is the same `readdir` a walk would have
 * done anyway, and the ten thousand file READS and HASHES the walk also implied
 * are what is actually saved.
 */
function rootOrderOf(graph, ctx, trustCache) {
  const order = [];
  for (const root of ctx.roots) {
    const abs = ctx.resolve(root);
    const stat = ctx.statOrNull(abs);
    if (stat == null) throw ctx.rootMissing(abs);
    if (stat.isFile()) {
      order.push({ rootId: abs, files: [abs] });
      continue;
    }
    let files = trustCache ? graph.rootFiles.get(abs) : undefined;
    if (files === undefined) {
      files = ctx.walkFiles(abs);
      graph.rootFiles.set(abs, files);
    }
    order.push({ rootId: abs, files });
  }
  return order;
}

/**
 * Whether the cached root file lists may be served instead of re-walking.
 *
 * They may only when this revision's input is TRUSTWORTHY - an explicit
 * mutation set the host performed, or a watcher that saw it - because that is
 * exactly the claim that makes a cached list correct. Under `full-discovery` the
 * caller has said it does not know what moved, so every root is re-walked: a
 * file that appeared outside any declared mutation has to be found, and a cache
 * that answered without being asked is how a project quietly stops compiling a
 * file somebody just created.
 */
function trustRootCache(graph, ctx) {
  const mode = ctx.dirtyInputMode();
  return (
    (mode === 'verified-explicit' || mode === 'watcher') &&
    ctx.fullDiscoveryReason() == null
  );
}

/**
 * The root directories a declared add or remove moved the membership of.
 *
 * A declared path OUTSIDE every root is not a shape change, and treating it as
 * one is expensive in exactly the case that matters most. An agent that adds the
 * module a broken import was waiting for, or repairs an import by adding the
 * file it names, has done the narrowest thing an agent can do - and paying for
 * it with a whole-project rebuild made the repair cost the thing it was
 * supposed to fix. Nothing about the root membership moved: a file under
 * nothing is not a root member, and it enters the closure the moment a covered
 * file imports it, which is an edge the examination below already follows.
 *
 * The same is true of a removal outside every root. The file leaves the closure
 * when its last importer stops importing it, and until then it stays as the
 * unreadable stub a fresh build would also produce.
 */
function directoriesToRefresh(graph, ctx) {
  const dirs = new Set();
  const applied = ctx.rootDelta;
  if (applied == null || graph.rootFiles.size === 0) {
    return { dirs };
  }
  for (const abs of [...applied.added, ...applied.removed]) {
    const owner = ctx.rootOwning(path.dirname(abs));
    if (owner !== null) dirs.add(owner);
  }
  return { dirs };
}

// -------------------------------------------------------------- derivation ---

function ensureNode(graph, file) {
  let node = graph.nodes.get(file);
  if (node == null) {
    node = newNode(file);
    graph.nodes.set(file, node);
  }
  return node;
}

/**
 * Reads the module summary of `file` and turns it into owned edges.
 *
 * This is the only place resolution is asked for, and it is asked only for a
 * file the revision could have changed, or for a node that has just been
 * created by an edge and therefore has no edges yet. A style-only edit - the
 * bytes differ, the import and export declarations do not - produces an empty
 * diff, and an empty diff is what lets a revision skip the closure entirely.
 */
function deriveEdges(graph, file, ctx, delta) {
  const summary = ctx.summaryFor(file);
  const edges = [];
  for (const edge of summary.edges) {
    const resolved =
      edge.local &&
      !edge.isStylesheet &&
      !edge.resource &&
      edge.computed !== true
        ? ctx.resolveLocal(file, edge.request)
        : null;
    edges.push(ownedEdge(edge, resolved));
  }
  const node = ensureNode(graph, file);
  if (node.derived) diffEdges(node.edges, edges, delta);
  node.edges = edges;
  node.unreadable = summary.unreadable === true;
  node.parseLocation = summary.parseLocation ?? null;
  node.importSources = summary.importSources ?? [];
  node.derived = true;
  return node;
}

/**
 * The per-file resolution record, rebuilt for the files whose edges were
 * re-derived.
 *
 * A compiled result is a function of whether a file's own local imports
 * resolve, so a request whose answer moved invalidates the file that asked it.
 * A file that is not derived keeps the record the last revision left, which is
 * the record its unchanged edges would have produced.
 */
function recordResolutions(file, node, ctx) {
  if (node.unreadable) return;
  const fileState = ctx.ensureFileState(file);
  for (const edge of node.edges) {
    if (!edge.local || edge.isStylesheet || edge.resource || edge.computed)
      continue;
    const before = fileState.edgeResolution.get(edge.request);
    if (before !== undefined && before !== edge.resolved) {
      ctx.invalidate(file);
    }
    fileState.edgeResolution.set(edge.request, edge.resolved);
  }
}

function diffEdges(previous, next, delta) {
  const before = new Map();
  previous.forEach((edge, i) => before.set(edgeKey(edge, i), edge));
  const seen = new Set();
  next.forEach((edge, i) => {
    const key = edgeKey(edge, i);
    seen.add(key);
    const old = before.get(key);
    if (old === undefined) {
      delta.edgesAdded += 1;
      if (
        edge.local &&
        !edge.resource &&
        !edge.computed &&
        edge.resolved == null
      ) {
        delta.unresolvedEdgesAdded += 1;
      }
      return;
    }
    if (old.resolved === edge.resolved) return;
    delta.edgesRetargeted += 1;
    if (edge.resolved != null) delta.unresolvedEdgesResolved += 1;
  });
  for (const key of before.keys()) {
    if (seen.has(key)) continue;
    delta.edgesRemoved += 1;
  }
}

// ------------------------------------------------------------ reachability ---

/**
 * `support(N) = rootIds(N) U { support(P) : P is a covered parent of N }`.
 */
function computeSupport(node, graph) {
  const next = new Set(node.rootIds);
  for (const parent of node.parents) {
    const parentNode = graph.nodes.get(parent);
    if (parentNode == null || !parentNode.covered) continue;
    for (const rootId of parentNode.support) next.add(rootId);
  }
  return next;
}

/**
 * THE REACHABILITY CASCADE.
 *
 * One worklist, seeded with every node whose inputs the delta touched, and it
 * handles growth and shrink with the same code - because `computeSupport` is a
 * definition rather than an arithmetic update, re-deriving is correct in both
 * directions, and a node is re-queued only when its support actually changed.
 *
 * On an addition the walk stops as soon as a child's support is unchanged, so
 * it visits the NEWLY REACHABLE region and nothing else: that is the "walk only
 * the newly reachable subtree" of a module appearing, and on a project whose
 * addition is local it touches a handful of nodes.
 *
 * On a removal it re-derives the affected region instead, and a node with
 * another covered parent never reaches zero - which is the diamond. A node that
 * does reach zero leaves coverage and its own children are re-derived in turn; a
 * node that keeps a parent does not, and neither does anything under it.
 *
 * FIRST IN, FIRST OUT, AND THAT IS NOT COSMETIC.
 *
 * A LIFO queue here re-derives a shared node once per PARENT rather than once
 * in total: ten thousand pages reaching one barrel each push it, and a stack
 * pops it between every pair of them, so a node with a thousand parents is
 * computed a thousand times and each computation unions a thousand support sets.
 * That is O(parents squared), and at c10000 it made a full graph rebuild take
 * 2.5 seconds where the previous implementation took 120 milliseconds. A FIFO
 * queue settles every parent before any child is reached, so each node is
 * computed once per propagation - and the traversal ORDER here is not semantic,
 * unlike the one in `materialise`, so nothing observable depends on it.
 */
function propagate(graph, seeds, delta) {
  const queue = [...seeds];
  const queued = new Set(seeds);
  let head = 0;
  let visits = 0;
  while (head < queue.length) {
    visits += 1;
    if (visits > PROPAGATION_VISIT_LIMIT) {
      delta.propagationAborted = true;
      return;
    }
    const file = queue[head++];
    queued.delete(file);
    const node = graph.nodes.get(file);
    if (node == null) continue;
    const next = computeSupport(node, graph);
    if (sameSet(next, node.support)) continue;
    node.support = next;
    delta.reachabilityUpdates += 1;
    const wasCovered = node.covered;
    node.covered = next.size > 0;
    if (node.covered !== wasCovered) {
      if (node.covered) {
        node.origin = 'root';
        delta.nodesEnteringCoverage.push(node.file);
      } else {
        node.origin = null;
        delta.nodesLeavingCoverage.push(node.file);
      }
    }
    for (const child of childrenOf(node)) {
      if (queued.has(child) || !graph.nodes.has(child)) continue;
      queued.add(child);
      queue.push(child);
    }
  }
}

/**
 * THE PRUNE.
 *
 * A node that no declared root reaches any more gives up its forward edges, its
 * reverse index entries, its support set and its root membership, and is
 * deleted. That is what keeps the graph proportional to the CURRENT project
 * rather than to everything the session has ever seen, which is a memory
 * property a 1000-revision churn test exists to catch.
 *
 * It is sound because a node can only become covered again through an EDGE; an
 * edge only appears when the file that owns it is examined; and the examination
 * that brings a node back also re-derives it. The worklist is bottom-up - a
 * released node strands its children, the stranding is re-propagated, and any
 * child that falls out is released in turn - so a whole subtree that lost its
 * last root path leaves in one pass and leaves nothing behind.
 *
 * A node whose FILE is gone keeps its place as an unreadable stub while a
 * covered edge still names it, because that stub is what makes the canonical
 * traversal emit the `<unparseable>` coverage gap the full rebuild emits. A node
 * that no covered edge names is not in the closure at all, so an unreadable
 * node that has become uncovered is pruned like any other.
 */
function pruneUncovered(graph, ctx, delta, touched) {
  if (delta.propagationAborted) return;
  const queue = [];
  const queued = new Set();
  const enqueue = (file) => {
    if (queued.has(file)) return;
    queued.add(file);
    queue.push(file);
  };
  for (const file of delta.nodesLeavingCoverage) enqueue(file);
  for (const file of touched) enqueue(file);

  while (queue.length > 0) {
    const file = queue.pop();
    queued.delete(file);
    const node = graph.nodes.get(file);
    if (node == null || node.covered) continue;
    const stranded = new Set();
    for (const target of childrenOf(node)) {
      const targetNode = graph.nodes.get(target);
      if (targetNode == null) continue;
      targetNode.parents.delete(file);
      stranded.add(targetNode.file);
    }
    for (const parent of node.parents) {
      graph.nodes.get(parent)?.parents.delete(file);
    }
    node.parents.clear();
    node.edges = [];
    node.rootIds.clear();
    node.support = new Set();
    node.derived = false;
    node.importSources = [];
    graph.nodes.delete(file);
    delta.nodesRemoved.push(file);
    delta.nodesPruned += 1;
    if (stranded.size === 0) continue;
    propagate(graph, stranded, delta);
    for (const strandedFile of stranded) enqueue(strandedFile);
    for (const left of delta.nodesLeavingCoverage) enqueue(left);
  }
}

/**
 * A node whose FILE is gone while a covered edge still names it.
 *
 * It keeps its place in the graph as an unreadable stub with no edges, because
 * that is what makes the canonical traversal emit the `<unparseable>` coverage
 * gap the full rebuild emits. A stub that reported a different answer would
 * break the oracle for the case it exists to describe. Its children are
 * released, because a file that is gone reaches nothing.
 *
 * The delta is told the edge set moved, even for a node that was a leaf. The
 * stub's own edges are now empty where they were not, and the closure it
 * belongs to is more than an ordering: it is the covered set AND the list of
 * things the project asked for and did not get. A leaf that goes away changes no
 * position and no membership, so nothing else in the gate would fire, and the
 * closure would be returned still reporting that leaf as a file that was read.
 */
function stubRemovedNode(graph, node, seeds, delta) {
  for (const target of childrenOf(node)) {
    const targetNode = graph.nodes.get(target);
    if (targetNode == null) continue;
    targetNode.parents.delete(node.file);
    seeds.add(targetNode);
  }
  node.edges = [];
  node.rootIds.clear();
  node.unreadable = true;
  node.parseLocation = null;
  node.derived = true;
  node.importSources = [];
  delta.edgeSetChanged = true;
}

// ------------------------------------------------------------- materialising -

/**
 * THE CANONICAL TRAVERSAL.
 *
 * The traversal `collectCoveredFiles` performs, in the same order with the same
 * queue discipline, because the build report and the CSS rule order are both
 * functions of the iteration order of the covered map. It differs from a cold
 * build in exactly one way: every input it needs is already in memory. No file
 * is read, no module is parsed, no resolution is probed, and no coverage record
 * is allocated from a scan.
 */
function materialise(graph, rootOrder, derive) {
  const covered = new Map();
  const queue = [];
  for (const { files } of rootOrder) {
    for (const file of files) {
      if (covered.has(file)) continue;
      covered.set(file, 'root');
      queue.push(file);
    }
  }

  const unresolved = [];
  const external = [];
  const relayEdges = [];

  while (queue.length > 0) {
    const file = queue.pop();
    // On a COLD BUILD the edges are derived here, in this pass, rather than in
    // a traversal of their own immediately before it. The two passes visited
    // the same files in the same order and produced the same answers; doing it
    // twice was paying twice, and at c10000 a rebuild that walked ten thousand
    // modules twice cost half a second more than the single traversal the
    // incremental path does.
    let node = graph.nodes.get(file);
    if (derive != null && (node == null || !node.derived)) {
      node = derive.derive(file);
      derive.record(file, node);
    }
    if (node == null) continue;
    if (node.unreadable) {
      unresolved.push({
        from: file,
        request:
          node.parseLocation == null ? '<unparseable>' : '<syntax-error>',
        form: node.parseLocation == null ? 'unreadable' : 'syntax',
        line: node.parseLocation?.line ?? null,
        column: node.parseLocation?.column ?? null,
      });
      continue;
    }
    for (const edge of node.edges) {
      if (edge.computed === true) {
        unresolved.push({
          from: file,
          request: '<computed>',
          form: edge.form,
          line: edge.line,
        });
        continue;
      }
      if (!edge.local) {
        if (edge.form !== 'import') {
          external.push({ from: file, request: edge.request, form: edge.form });
        }
        continue;
      }
      if (edge.isStylesheet) continue;
      if (edge.resource) continue;
      if (edge.resolved == null) {
        unresolved.push({
          from: file,
          request: edge.request,
          form: edge.form,
          line: edge.line,
        });
        continue;
      }
      if (!covered.has(edge.resolved)) {
        covered.set(edge.resolved, `closure:${edge.form}`);
        relayEdges.push({
          from: file,
          to: edge.resolved,
          form: edge.form,
          request: edge.request,
        });
        const child = ensureNode(graph, edge.resolved);
        child.parents.add(file);
        queue.push(edge.resolved);
      } else {
        ensureNode(graph, edge.resolved).parents.add(file);
      }
    }
  }

  for (const [file, origin] of covered) {
    const node = graph.nodes.get(file);
    if (node != null) node.origin = origin;
  }
  return { covered, unresolved, external, relayEdges };
}

// -------------------------------------------------------------- the refresh --

/**
 * The whole revision, and the only entry point the session needs.
 *
 * Returns the revision's closure and the delta that produced it. Every counter
 * is recorded even on the fast path, where most of them are zero: a metric that
 * only appears when something went wrong cannot be used to show that something
 * did not.
 */
export function refreshCoverageClosure(graph, ctx) {
  const started = nowNs();
  const delta = emptyDelta();
  const configuredRoots = ctx.roots.map(ctx.resolve);
  const rebuildReason = rebuildReasonFor(graph, ctx, configuredRoots);
  let fullWalk = false;
  let fullFallback = false;
  let fallbackReason = null;

  if (rebuildReason != null) {
    fullWalk = true;
    // A first revision is not a FALLBACK: the cold build is the reference, and
    // calling the reference a degraded answer would make the counter lie about
    // the one revision whose answer nothing is compared against.
    fullFallback = graph.closure != null;
    if (fullFallback) fallbackReason = rebuildReason;
    ctx.bump(`closure_rebuild_reason_${rebuildReason}`);
    rebuildGraph(graph, ctx, delta, configuredRoots);
  } else {
    const refresh = directoriesToRefresh(graph, ctx);
    if (refresh.dirs.size > 0) {
      const previousRootFiles = new Map();
      for (const dir of refresh.dirs) {
        previousRootFiles.set(dir, graph.rootFiles.get(dir));
        graph.rootFiles.set(dir, ctx.walkFiles(dir));
        ctx.bump('discovery_directory_rereads', 1);
      }
      collectRootMembership(graph, delta, previousRootFiles);
    }
    examineRevision(graph, ctx, delta);
  }

  // THE ORDERING GATE.
  //
  // The canonical order is re-derived exactly when something that could move a
  // file's POSITION in it moved: an edge set changed (which can change the
  // discovery order even when the covered set is identical), a root's file list
  // changed (which changes the root prefix), or a node entered or left coverage.
  // A revision that changed none of those returns the previous closure object
  // untouched, having visited no node at all.
  if (
    !fullWalk &&
    (delta.edgeSetChanged ||
      delta.rootsEntered.length > 0 ||
      delta.rootsLeft.length > 0 ||
      delta.nodesEnteringCoverage.length > 0 ||
      delta.nodesLeavingCoverage.length > 0)
  ) {
    fullWalk = true;
  }

  if (fullWalk || graph.closure == null) {
    // `null` for the derive step: on an INCREMENTAL revision every node's edges
    // are already derived, so the traversal is a pure walk of owned data. A
    // rebuild has just derived them itself and reuses what it built.
    graph.closure = materialise(
      graph,
      rootOrderOf(graph, ctx, trustRootCache(graph, ctx)),
      null,
    );
    // The cascade's covered set and the traversal's covered set are two
    // independent answers to the same question. The traversal had to run anyway
    // for the order, so the cross-check is free, and a disagreement is counted
    // rather than hidden.
    delta.setDivergence = compareCoveredSets(graph);
  }

  graph.revision += 1;
  graph.fullFallback = fullFallback;
  graph.fullFallbackReason = fallbackReason;

  const covered = graph.closure.covered.size;
  return {
    closure: graph.closure,
    delta,
    fullWalk,
    rebuildReason,
    fullFallback,
    fullFallbackReason: fallbackReason,
    nodesExamined: delta.filesExamined,
    nodesAdded: delta.nodesAdded.length,
    nodesRemoved: delta.nodesRemoved.length,
    nodesEnteringCoverage: delta.nodesEnteringCoverage.length,
    nodesLeavingCoverage: delta.nodesLeavingCoverage.length,
    nodesReused: Math.max(0, covered - delta.filesExamined),
    edgesRecomputed:
      delta.edgesAdded + delta.edgesRemoved + delta.edgesRetargeted,
    reachabilityUpdates: delta.reachabilityUpdates,
    elapsedMs: (nowNs() - started) / 1e6,
  };
}

/**
 * The cascade's covered set against the traversal's, node by node.
 *
 * Zero is the only correct answer. Anything else is a defect in the graph, and
 * reporting the number is how it would be noticed.
 */
function compareCoveredSets(graph) {
  let divergence = 0;
  for (const node of graph.nodes.values()) {
    if (graph.closure.covered.has(node.file) !== node.covered) divergence += 1;
  }
  for (const file of graph.closure.covered.keys()) {
    if (!graph.nodes.has(file)) divergence += 1;
  }
  return divergence;
}

/**
 * Why this revision cannot be a delta of the previous one, or null when it can.
 *
 * `first-revision` is a real answer and not a formality: the graph starts empty,
 * so there is nothing to take a delta of, and the only correct closure is the
 * cold one. It is reported so a reader can tell "the graph was rebuilt because
 * it did not exist" from "the graph was rebuilt because the roots moved", which
 * are the same cost and completely different facts.
 */
function rebuildReasonFor(graph, ctx, configuredRoots) {
  if (graph.closure == null || graph.roots == null) return 'first-revision';
  if (!sameArray(graph.roots, configuredRoots)) return 'roots';
  if (ctx.closureFallbackReason() != null) return ctx.closureFallbackReason();
  if (ctx.fullDiscoveryReason() != null) return ctx.fullDiscoveryReason();
  if (ctx.dirtyInputMode() === 'full-discovery') return 'full-discovery';
  return null;
}

/**
 * The cold build, and the only way back to the reference after a fallback.
 *
 * It re-reads every root, derives every node's edges from the persistent module
 * summaries, and re-seeds reachability from the roots. Nothing is reused from
 * the previous revision except the summaries themselves, which is the reuse
 * Spike 2 established and the reuse Phase D is not touching.
 */
function rebuildGraph(graph, ctx, delta, configuredRoots) {
  graph.roots = configuredRoots;
  graph.nodes.clear();
  const rootOrder = rootOrderOf(graph, ctx, trustRootCache(graph, ctx));
  for (const { rootId, files } of rootOrder) {
    for (const file of files) ensureNode(graph, file).rootIds.add(rootId);
  }

  // One pass: derive the edges and walk the closure together, exactly as a cold
  // full rebuild does.
  graph.closure = materialise(graph, rootOrder, {
    derive: (file) => {
      delta.filesExamined += 1;
      return deriveEdges(graph, file, ctx, delta);
    },
    record: (file, node) => recordResolutions(file, node, ctx),
  });

  // The roots' support, then one cascade over the whole graph: a cold build
  // knows every node already, so this is a single propagation rather than a
  // walk per addition. The cascade and the traversal are two independent
  // answers to "what is covered"; they are compared below rather than assumed
  // to agree.
  const seeds = new Set();
  for (const node of graph.nodes.values()) {
    if (node.rootIds.size > 0) seeds.add(node.file);
  }
  propagate(graph, seeds, delta);
  pruneUncovered(graph, ctx, delta, seeds);
  propagate(graph, seeds, delta);
  delta.setDivergence = compareCoveredSets(graph);
}

// ------------------------------------------------------------- examination ---

/**
 * The files this revision has to look at.
 *
 * Three sources and no others: the files the caller declared, the files whose
 * presence changed, and the files whose resolution was re-probed. A file that
 * is none of those cannot have different edges than it had, so examining it
 * could only confirm what the graph already says - and a loop that walks ten
 * thousand nodes to confirm that is the exact failure this file exists to
 * remove.
 */
function examineRevision(graph, ctx, delta) {
  const examined = new Set();
  const changes = [];
  const seeds = new Set();

  const consider = (file) => {
    if (examined.has(file)) return;
    examined.add(file);
    const change = examineOne(graph, file, ctx, delta);
    if (change != null) changes.push(change);
  };
  // `ctx.needsExamination`, and NOT `ctx.dirty`.
  //
  // These are different sets and conflating them is expensive. A file is dirty
  // when its COMPILED RESULT may be stale, which a global fallback makes true of
  // every file in the project. A file needs examination when its MODULE EDGES may
  // have moved, which is true only of the files whose bytes were actually read
  // and found changed this revision, the files that went away, and the files
  // whose negative resolution was re-probed.
  //
  // The distinction is worth two and a half seconds at c10000: project-wide
  // definition invalidation used to mark every covered file dirty, and reading
  // "dirty" as "examine" made every one of ten thousand files be read from disk
  // to be told that its imports had not moved. Semantic definition changes now
  // seed consumers through the session semantic index. A configuration change
  // cannot move a module edge, and on the verified-explicit route the caller has
  // already said which paths it wrote.
  for (const file of ctx.needsExamination) consider(file);
  for (const file of ctx.removedFiles) consider(file);
  for (const file of ctx.repairedResolutions) consider(file);

  if (changes.length === 0 && seeds.size === 0) return;
  applyChanges(graph, changes, delta, seeds);
  deriveUnseenSubtree(graph, seeds, ctx, delta);
  propagate(graph, seeds, delta);
  pruneUncovered(graph, ctx, delta, seeds);
  propagate(graph, seeds, delta);
}

function examineOne(graph, file, ctx, delta) {
  delta.filesExamined += 1;
  const node = graph.nodes.get(file);

  if (ctx.gone(file)) {
    // The file state's CONTENT HASH IS CLEARED HERE, and that is not a detail.
    //
    // A file that is gone but still named by a covered edge stays in the graph
    // as an unreadable stub, so it will be examined again when its bytes come
    // back. If its file state still carried the hash of the bytes that are no
    // longer there, the restoration would compare equal to itself, the session
    // would see no change, and the file would come back without ever being
    // re-analysed. `summaryFor` is what records the absence - it is the same
    // call the old full traversal made for every covered file, and it is where
    // `sourceHash` becomes null.
    ctx.summaryFor(file);
    if (node == null) {
      // Gone and never known. A cold rebuild would not reach it either, and a
      // node created for it would be a node with nothing in it.
      return null;
    }
    return { file, kind: 'removed', previousTargets: childrenOf(node) };
  }

  const hadEdges = node != null && node.derived;
  const previousEdges = hadEdges ? node.edges : null;
  const previousParseLocation = node?.parseLocation ?? null;
  const previousUnreadable = node?.unreadable ?? false;
  const previousTargets = node != null ? childrenOf(node) : [];
  const derived = deriveEdges(graph, file, ctx, delta);
  recordResolutions(file, derived, ctx);
  const nextTargets = childrenOf(derived);

  if (node == null) {
    delta.nodesAdded.push(file);
    delta.edgeSetChanged = true;
    return { file, kind: 'added', previousTargets, nextTargets };
  }
  if (
    hadEdges &&
    sameEdges(previousEdges, derived.edges) &&
    sameParseLocation(previousParseLocation, derived.parseLocation) &&
    previousUnreadable === derived.unreadable
  ) {
    // A STYLE-ONLY EDIT LANDS HERE: the bytes differ, the import and export
    // declarations do not. `deriveEdges` already compared the two edge lists and
    // counted the difference as zero, so the revision has nothing to do to the
    // graph and the closure object is returned untouched.
    return null;
  }
  delta.edgeSetChanged = true;
  return { file, kind: 'edges', previousTargets, nextTargets };
}

function sameEdges(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!sameEdge(a[i], b[i])) return false;
  return true;
}

function sameParseLocation(a, b) {
  return (
    (a?.line ?? null) === (b?.line ?? null) &&
    (a?.column ?? null) === (b?.column ?? null)
  );
}

/**
 * The changes, in the order the indexes have to be rewritten in.
 *
 * The reverse index is registered for a file's CURRENT targets and deregistered
 * from the targets it no longer names, in one pass, so it always describes the
 * revision that is being built rather than a mixture of two. Root membership is
 * applied after every edge, because a node's support is a function of both and a
 * cascade started before the last of either was written would compute a support
 * from a graph that no longer exists.
 */
function applyChanges(graph, changes, delta, seeds) {
  for (const change of changes) {
    if (change.kind === 'removed') {
      const node = graph.nodes.get(change.file);
      if (node == null) continue;
      stubRemovedNode(graph, node, seeds, delta);
      continue;
    }
    const previous = change.previousTargets;
    const next = change.nextTargets;
    for (const target of previous) {
      if (next.includes(target)) continue;
      const targetNode = graph.nodes.get(target);
      if (targetNode == null) continue;
      targetNode.parents.delete(change.file);
      seeds.add(targetNode.file);
    }
    for (const target of next) {
      ensureNode(graph, target).parents.add(change.file);
      seeds.add(target);
    }
    seeds.add(change.file);
  }

  for (const entry of delta.rootsEntered) {
    ensureNode(graph, entry.file).rootIds.add(entry.rootId);
    seeds.add(entry.file);
  }
  for (const entry of delta.rootsLeft) {
    graph.nodes.get(entry.file)?.rootIds.delete(entry.rootId);
    seeds.add(entry.file);
  }
}

/**
 * Nodes that an edge just named, and whose edges nobody has derived yet.
 *
 * This is the "walk only the newly reachable subtree" of a module appearing, and
 * the reason a node carries a `derived` flag at all: a node can enter the graph
 * through somebody else's edge before anything has ever looked at its own
 * imports, and asking then is a cached summary lookup plus a cached resolution -
 * no parse, no probe - rather than a traversal of the project.
 */
function deriveUnseenSubtree(graph, seeds, ctx, delta) {
  const queue = [...seeds];
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const node = graph.nodes.get(file);
    if (node == null) continue;
    if (ctx.gone(file)) {
      if (!node.unreadable) stubRemovedNode(graph, node, seeds, delta);
      continue;
    }
    if (node.derived) continue;
    delta.filesExamined += 1;
    const derived = deriveEdges(graph, file, ctx, delta);
    recordResolutions(file, derived, ctx);
    for (const target of childrenOf(derived)) {
      ensureNode(graph, target).parents.add(file);
      seeds.add(target);
      if (!graph.nodes.get(target).derived) queue.push(target);
    }
  }
}

/**
 * Root membership, recomputed ONLY for the directories that moved.
 *
 * A directory that was not re-read cannot have gained or lost a member, so its
 * nodes' `rootIds` are left exactly as they were. This is what keeps a module
 * add or remove proportional to the affected directory rather than to the
 * project: re-deriving "which files are under which root" from scratch is
 * O(project) and there is no reason to do it when one `readdir` already
 * answered the question for the one directory that changed.
 */
function collectRootMembership(graph, delta, previousRootFiles) {
  for (const [dir, previous] of previousRootFiles) {
    const next = graph.rootFiles.get(dir) ?? [];
    if (previous === undefined) {
      for (const file of next) {
        const node = ensureNode(graph, file);
        if (node.rootIds.has(dir)) continue;
        node.rootIds.add(dir);
        delta.rootsEntered.push({ file, rootId: dir });
      }
      continue;
    }
    const before = new Set(previous);
    const after = new Set(next);
    for (const file of before) {
      if (after.has(file)) continue;
      const node = graph.nodes.get(file);
      if (node == null || !node.rootIds.has(dir)) continue;
      node.rootIds.delete(dir);
      delta.rootsLeft.push({ file, rootId: dir });
    }
    for (const file of after) {
      if (before.has(file)) continue;
      const node = ensureNode(graph, file);
      if (node.rootIds.has(dir)) continue;
      node.rootIds.add(dir);
      delta.rootsEntered.push({ file, rootId: dir });
    }
  }
}

// ------------------------------------------------------------------ the audit

/**
 * The full audit.
 *
 * Recomputes the covered set, the origins, the canonical order, the unresolved
 * edges, the external requests and the relay edges FROM THE MODULE SUMMARIES,
 * with no reuse of the incremental structure, and compares. It is deliberately
 * not on the hot path: an agent revision must never need it, and a test allowed
 * to ask for it is a test allowed to be slow.
 */
export function verifyCoverageGraph(graph, ctx) {
  const differences = [];
  const reference = new Map();
  const order = [];
  const queue = [];
  for (const root of ctx.roots) {
    const abs = ctx.resolve(root);
    const stat = ctx.statOrNull(abs);
    if (stat == null) continue;
    if (stat.isFile()) {
      if (!reference.has(abs)) {
        reference.set(abs, 'root');
        order.push(abs);
        queue.push(abs);
      }
      continue;
    }
    for (const file of ctx.walkFiles(abs)) {
      if (!reference.has(file)) {
        reference.set(file, 'root');
        order.push(file);
        queue.push(file);
      }
    }
  }

  const unresolved = [];
  const external = [];
  const relayEdges = [];
  while (queue.length > 0) {
    const file = queue.pop();
    const summary = ctx.summaryFor(file);
    if (summary.unreadable) {
      unresolved.push({
        from: file,
        request:
          summary.parseLocation == null ? '<unparseable>' : '<syntax-error>',
        form: summary.parseLocation == null ? 'unreadable' : 'syntax',
        line: summary.parseLocation?.line ?? null,
        column: summary.parseLocation?.column ?? null,
      });
      continue;
    }
    for (const edge of summary.edges) {
      if (edge.computed === true) {
        unresolved.push({
          from: file,
          request: '<computed>',
          form: edge.form,
          line: edge.line,
        });
        continue;
      }
      if (!edge.local) {
        if (edge.form !== 'import') {
          external.push({ from: file, request: edge.request, form: edge.form });
        }
        continue;
      }
      if (edge.isStylesheet) continue;
      if (edge.resource) continue;
      const resolved = ctx.resolveLocal(file, edge.request);
      if (resolved == null) {
        unresolved.push({
          from: file,
          request: edge.request,
          form: edge.form,
          line: edge.line,
        });
        continue;
      }
      if (!reference.has(resolved)) {
        reference.set(resolved, `closure:${edge.form}`);
        order.push(resolved);
        relayEdges.push({
          from: file,
          to: resolved,
          form: edge.form,
          request: edge.request,
        });
        queue.push(resolved);
      }
    }
  }

  const closure = graph.closure;
  if (closure == null) {
    differences.push({
      kind: 'closure',
      detail: 'the graph has no materialised closure',
    });
    return { ok: false, differences };
  }
  const actual = closure.covered;
  if (actual.size !== reference.size) {
    differences.push({
      kind: 'covered-size',
      incremental: actual.size,
      fresh: reference.size,
    });
  }
  let index = 0;
  for (const [file, origin] of actual) {
    const expected = reference.get(file);
    if (expected === undefined) {
      differences.push({ kind: 'extra-covered', file });
      continue;
    }
    if (origin !== expected) {
      differences.push({
        kind: 'origin',
        file,
        incremental: origin,
        fresh: expected,
      });
    }
    if (order[index] !== file) {
      differences.push({
        kind: 'order',
        position: index,
        incremental: file,
        fresh: order[index] ?? null,
      });
    }
    index += 1;
  }
  for (const file of reference.keys()) {
    if (!actual.has(file)) differences.push({ kind: 'missing-covered', file });
  }
  compareRecords('unresolved', closure.unresolved, unresolved, differences);
  compareRecords('external', closure.external, external, differences);
  compareRecords('relay', closure.relayEdges, relayEdges, differences);
  return { ok: differences.length === 0, differences };
}

function compareRecords(kind, actual, expected, differences) {
  if (actual.length !== expected.length) {
    differences.push({
      kind: `${kind}-length`,
      incremental: actual.length,
      fresh: expected.length,
    });
  }
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i += 1) {
    const a = JSON.stringify(actual[i]);
    const b = JSON.stringify(expected[i]);
    if (a !== b) {
      differences.push({
        kind: `${kind}-record`,
        index: i,
        incremental: a,
        fresh: b,
      });
    }
  }
}

/**
 * The structural counts a leak would move.
 *
 * Current state only. A node keeps no revision history and the graph keeps no
 * revision list, because a history would be memory that buys nothing: a hundred
 * thousand revisions of a ten thousand node project is a gigabyte of numbers
 * describing graphs that no longer exist.
 */
export function coverageGraphStats(graph) {
  let covered = 0;
  let forward = 0;
  let reverse = 0;
  let support = 0;
  for (const node of graph.nodes.values()) {
    if (node.covered) covered += 1;
    forward += node.edges.length;
    reverse += node.parents.size;
    support += node.support.size;
  }
  let rootFileEntries = 0;
  for (const files of graph.rootFiles.values()) rootFileEntries += files.length;
  return {
    revision: graph.revision,
    nodes: graph.nodes.size,
    coveredNodes: covered,
    forwardEdges: forward,
    reverseEdges: reverse,
    supportEntries: support,
    rootFileLists: graph.rootFiles.size,
    rootFileEntries,
  };
}
