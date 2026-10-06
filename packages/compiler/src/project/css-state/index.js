/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the project's stylesheet, as INCREMENTAL state (Spike 3, Phase B).
 *
 * WHAT THIS IS
 *
 * A project-level owner of the cascade. The StyleX aggregator is unchanged and
 * remains the semantic reference: this module reuses its comparator, its
 * specificity bump, its theme-selector rewrite, its RTL wrapping and its layer
 * grouping, and adds exactly one thing it never had - a record of WHICH FILES
 * OWN EACH RULE, so that a rule whose last owner leaves can disappear and a rule
 * whose owner merely changed can stay.
 *
 * THE PROBLEM IT SOLVES
 *
 * A full aggregation is O(total rule contributions): it re-derives the whole
 * cascade order and re-serialises the whole stylesheet on every revision, for a
 * revision that changed one file. Measured at c10000 that was 210ms of a
 * 950ms revision.
 *
 * THE MODEL
 *
 *   RuleRecord  one atomic rule: its class name, its priority, its rendered
 *               text, and the SET of files that contribute it.
 *
 *   A file owns a rule while the file's contribution names it. The rule exists
 *   while at least one file owns it. Deleting one of two owners therefore does
 *   NOT remove the rule, and the rule disappears only when its owner set empties
 *   - which is the property a refcount has to have and the one a "re-derive from
 *   the surviving files" approach gets for free only by doing the whole job again.
 *
 * RULE IDENTITY
 *
 * The class name, and that is not an assumption. The aggregator's own
 * deduplication is `new Map(rules.map(([a, b]) => [a, b]))` - keyed on `a`, the
 * class name, which is StyleX's content hash of the atomic declaration. This
 * module keys on the same thing, and then VERIFIES it: when a second owner
 * arrives, the rendered text and priority it carries are compared against the
 * ones already recorded, and a disagreement is a fallback rather than a silent
 * pick. If the class name were ever not sufficient, the fallback fires and the
 * output is still correct.
 *
 * ORDERING
 *
 * Cascade order is semantic, so "append the new rule at the end" is exactly the
 * wrong answer and is not implemented anywhere in this file. The order is
 * maintained with the aggregator's own comparator: a new rule is binary-searched
 * into the sorted array at the position that comparator gives it, and a removed
 * rule is spliced out. Because the ordering is total - the final tiebreak is the
 * whole rule text, which contains a unique class name - an array built this way
 * is the array a full `.sort()` of the same contributions would produce.
 *
 * WHAT IS STILL O(total), AND WHY THAT IS THE POINT
 *
 * Two things, and both are measured separately from the rule update:
 *
 *   - grouping walks the sorted array. O(n) pointer comparisons, no string work.
 *   - joining the group texts into one stylesheet. O(bytes), unavoidable while
 *     the published artifact is a single file.
 *
 * Everything expensive - ordering a new rule, transforming a rule into its final
 * text, re-serialising a layer group - is done once per CHANGED rule, and a
 * group is re-serialised only when one of its members changed.
 */

import {
  createRuleComparator,
  layerHeader,
  logicalFloatVars as computeLogicalFloatVars,
  splitConstantRules,
  transformRuleEntry,
} from '../../engine/index';
import { count, perfNow } from '../../observability/metrics';

/** The owner key reserved for the design system's own injected rules. */
const DESIGN_SYSTEM_OWNER = '\u0000pandamstyle:design-system';

function digestOfRuleText(ltr, rtl) {
  // A cheap, stable identity for a rendered rule. Used to answer "did this
  // owner's version of the rule differ?" without keeping the strings twice.
  let h = 5381;
  for (let i = 0; i < ltr.length; i++)
    h = ((h << 5) + h + ltr.charCodeAt(i)) | 0;
  if (rtl != null) {
    for (let i = 0; i < rtl.length; i++)
      h = ((h << 5) + h + rtl.charCodeAt(i)) | 0;
  }
  return `${h}:${ltr.length}:${rtl == null ? -1 : rtl.length}`;
}

/**
 * @param config the aggregator's own config object, passed straight through so
 *        the two cannot disagree about layers, legacy classname order, RTL
 *        comments or legacy layer disabling.
 */
export function createCssState(config) {
  const compare = createRuleComparator(config);
  const transform = transformRuleEntry;

  /** className -> record. */
  const records = new Map();
  /** file -> Set<className> */
  const ownerIndex = new Map();
  /** The sorted array. */
  let ordered = [];
  /** The current constant-substitution table, and a digest of its identity. */
  let constSig = null;
  /** Current design-system-owned CSS rule identity, keyed by class name. */
  let designSystemRuleKeys = new Map();
  /** Groups of `ordered` split by Math.floor(priority / 1000). */
  let groups = [];
  /** How many records carry a logical float, for the preamble. */
  let logicalFloatCount = 0;
  let lastCss = null;

  // Per-revision. A benchmark row has to describe the revision it was taken in,
  // so these are reset at the start of every `apply` and are not cumulative.
  let revision = {
    rulesAdded: 0,
    rulesRemoved: 0,
    refcountChanged: 0,
    orderInserted: 0,
    orderRemoved: 0,
  };
  const totals = { fallbacks: 0, lastFallbackReason: null };

  // ------------------------------------------------------------ identity ----

  const tupleOf = (record) => [
    record.className,
    { ltr: record.ltr, rtl: record.rtl },
    record.priority,
  ];

  /**
   * Where `record` belongs in the sorted array, by the aggregator's comparator.
   *
   * A binary search over the existing order. The comparator is total, so this
   * finds the same position a full sort would have placed the rule at.
   */
  const insertionPoint = (record) => {
    let lo = 0;
    let hi = ordered.length;
    const tuple = tupleOf(record);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(tupleOf(ordered[mid]), tuple) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const insertOrdered = (record) => {
    const at = insertionPoint(record);
    ordered.splice(at, 0, record);
    return at;
  };

  // ------------------------------------------------------ constant rules ----

  const buildConsts = (constantRules) => {
    const constsMap = new Map();
    for (const [keyhash, ruleObj] of constantRules) {
      const constVal = ruleObj.constVal;
      const constName = `var(--${keyhash})`;
      constsMap.set(constName, constVal);
    }
    const parts = [];
    const resolveConstant = (value, visited = new Set()) => {
      if (typeof value !== 'string') return value;
      const regex = /var\((--[A-Za-z0-9_-]+)\)/g;
      let result = value;
      let match;
      while ((match = regex.exec(result)) !== null) {
        if (match == null) continue;
        const ref = match[1];
        if (visited.has(ref)) {
          throw new Error(`circular reference detected for constant ${ref}`);
        }
        const refKey = `var(${ref})`;
        const refValue = constsMap.get(refKey);
        if (refValue == null) continue;
        visited.add(ref);
        const replacement = resolveConstant(refValue, visited);
        result = result.replace(match[0], () => replacement.toString());
        visited.delete(ref);
        regex.lastIndex = 0;
      }
      return result;
    };
    for (const [key, value] of constsMap.entries()) {
      const resolved = resolveConstant(value);
      constsMap.set(key, resolved);
      parts.push(`${key}=${String(resolved)}`);
    }
    return { constsMap, sig: parts.sort().join('|') };
  };

  /**
   * The aggregator's constant substitution, applied to one rule's text.
   *
   * This runs BEFORE ordering, because the comparator reads the substituted
   * text. That is also why a change to the constant set invalidates the whole
   * order rather than a few rules: the keys the comparator compares can all
   * move at once.
   */
  const substitute = (styleObj, constsMap) => {
    const out = {};
    for (const dir of Object.keys(styleObj)) {
      let original = styleObj[dir];
      for (const [varRef, constValue] of constsMap.entries()) {
        if (typeof original !== 'string') continue;
        const replacement = String(constValue);
        original = original.replaceAll(varRef, () => replacement);
        if (replacement.startsWith('var(') && replacement.endsWith(')')) {
          const inside = replacement.slice(4, -1).trim();
          const commaIdx = inside.indexOf(',');
          const targetName = commaIdx >= 0 ? inside.slice(0, commaIdx) : inside;
          const constName = varRef.slice(4, -1);
          original = original.replaceAll(`${constName}:`, `${targetName}:`);
        }
        out[dir] = original;
      }
      if (out[dir] === undefined) out[dir] = original;
    }
    return out;
  };

  // ------------------------------------------------------------- mutation ----

  const makeRecord = (className, styleObj, priority, constsMap) => {
    const substituted = substitute(styleObj, constsMap);
    const ltr = substituted.ltr;
    const rtl = substituted.rtl ?? null;
    // The logical-float preamble, decided by the aggregator's own function for
    // this one rule. O(1) per new rule, and no second copy of the predicate.
    const hasLogicalFloat =
      computeLogicalFloatVars([[className, styleObj, priority]]) !== '';
    return {
      className,
      priority: priority ?? 0,
      ltr,
      rtl,
      textDigest: digestOfRuleText(ltr, rtl),
      owners: new Set(),
      hasLogicalFloat,
      isConstant: styleObj?.constKey != null && styleObj?.constVal != null,
    };
  };

  /** The reason the current state cannot be maintained incrementally. */
  let identityViolation = null;

  const addOwner = (owner, className, styleObj, priority, duringRebuild) => {
    let record = records.get(className);
    if (record === undefined) {
      record = makeRecord(className, styleObj, priority, currentConsts);
      records.set(className, record);
      if (duringRebuild) {
        // The rebuild sorts ONCE at the end; inserting here would be quadratic.
        ordered.push(record);
      } else {
        // The caller places it, once, after this file's whole contribution is
        // in. Placing it here AND there is how a rule ends up in the stylesheet
        // twice - once in its cascade position and once at the end.
        record.needsOrdering = true;
        revision.orderInserted += 1;
      }
      // Counted either way. A rebuild creates every rule in the project, and
      // reporting that as zero additions would make the most expensive path the
      // only one that claims to have done nothing.
      revision.rulesAdded += 1;
      if (record.hasLogicalFloat) logicalFloatCount += 1;
    } else {
      // THE IDENTITY CLAIM, CHECKED RATHER THAN ASSUMED.
      //
      // Two owners naming the same class name must be describing the same
      // atomic rule. StyleX's class name is a content hash of the declaration, so
      // they do - and this compares the rendered text anyway, because "they do"
      // is a property of the backend that this layer should not take on trust.
      // A disagreement is a fallback, never a silent preference for one of them.
      const substituted = substitute(styleObj, currentConsts);
      const candidate = digestOfRuleText(
        substituted.ltr,
        substituted.rtl ?? null,
      );
      if (
        candidate !== record.textDigest ||
        (priority ?? 0) !== record.priority
      ) {
        identityViolation = {
          className,
          expected: record.textDigest,
          actual: candidate,
          priority: [record.priority, priority ?? 0],
        };
        return;
      }
      if (!duringRebuild) revision.refcountChanged += 1;
    }
    if (record.owners.has(owner)) return;
    record.owners.add(owner);
    let owned = ownerIndex.get(owner);
    if (owned === undefined) {
      owned = new Set();
      ownerIndex.set(owner, owned);
    }
    owned.add(className);
  };

  /**
   * Retires one owner's contribution.
   *
   * A rule whose owner set is still non-empty SURVIVES - that is the whole
   * point of tracking ownership - and only a rule whose last owner has left is
   * removed. The removal is a single filter pass rather than one search per
   * rule, so the cost is one pass over the rule set per file that changed.
   */
  const dropOwner = (owner) => {
    const owned = ownerIndex.get(owner);
    if (owned === undefined) return 0;
    ownerIndex.delete(owner);
    const dead = new Set();
    for (const className of owned) {
      const record = records.get(className);
      if (record === undefined) continue;
      record.owners.delete(owner);
      if (record.owners.size > 0) {
        revision.refcountChanged += 1;
        continue;
      }
      dead.add(record);
      if (record.hasLogicalFloat) logicalFloatCount -= 1;
      records.delete(className);
    }
    if (dead.size === 0) return 0;
    ordered = ordered.filter((r) => !dead.has(r));
    revision.rulesRemoved += dead.size;
    revision.orderRemoved += dead.size;
    return dead.size;
  };

  const removeOwnerClasses = (owner, classNames) => {
    const owned = ownerIndex.get(owner);
    if (owned === undefined || classNames.length === 0) return 0;
    const dead = new Set();
    for (const className of classNames) {
      if (!owned.delete(className)) continue;
      const record = records.get(className);
      if (record === undefined) continue;
      record.owners.delete(owner);
      if (record.owners.size > 0) {
        revision.refcountChanged += 1;
        continue;
      }
      dead.add(record);
      if (record.hasLogicalFloat) logicalFloatCount -= 1;
      records.delete(className);
    }
    if (owned.size === 0) ownerIndex.delete(owner);
    if (dead.size === 0) return 0;
    ordered = ordered.filter((record) => !dead.has(record));
    revision.rulesRemoved += dead.size;
    revision.orderRemoved += dead.size;
    return dead.size;
  };

  let currentConsts = new Map();

  const signatureOfRule = (styleObj, priority) => {
    const substituted = substitute(styleObj, currentConsts);
    return `${priority ?? 0}\u0000${digestOfRuleText(
      substituted.ltr,
      substituted.rtl ?? null,
    )}`;
  };

  const updateDesignSystemOwner = (rules) => {
    const nextRules = new Map();
    for (const [className, styleObj, priority] of rules ?? []) {
      if (styleObj?.constKey != null && styleObj?.constVal != null) continue;
      nextRules.set(className, {
        styleObj,
        priority,
        signature: signatureOfRule(styleObj, priority),
      });
    }
    const changed = [];
    for (const [className, previous] of designSystemRuleKeys) {
      if (nextRules.get(className)?.signature !== previous.signature)
        changed.push(className);
    }
    removeOwnerClasses(DESIGN_SYSTEM_OWNER, changed);
    for (const [className, next] of nextRules) {
      if (designSystemRuleKeys.get(className)?.signature === next.signature)
        continue;
      addOwner(
        DESIGN_SYSTEM_OWNER,
        className,
        next.styleObj,
        next.priority,
        false,
      );
      const record = records.get(className);
      if (record?.needsOrdering === true) {
        record.needsOrdering = false;
        insertOrdered(record);
      }
    }
    designSystemRuleKeys = nextRules;
  };

  /** Replaces one file's whole contribution. */
  const setFile = (file, rules) => {
    dropOwner(file);
    let added = 0;
    for (const [className, styleObj, priority] of rules) {
      if (styleObj?.constKey != null && styleObj?.constVal != null) continue;
      addOwner(file, className, styleObj, priority, false);
      added += 1;
    }
    // Place this file's new rules in the cascade, each at the position the
    // aggregator's comparator gives it. Inserting them one at a time is safe
    // precisely BECAUSE the comparator is a total order: the array is sorted
    // again after every insertion, so the next binary search sees a sorted array.
    for (const className of ownerIndex.get(file) ?? []) {
      const record = records.get(className);
      if (record === undefined || record.needsOrdering !== true) continue;
      record.needsOrdering = false;
      insertOrdered(record);
    }
    if (added === 0 && identityViolation == null) ownerIndex.delete(file);
  };

  // ------------------------------------------------------------- fallback ----

  /**
   * Discards everything and re-derives from the full contribution set.
   *
   * Taken when rule identity or constant substitution changes in a way the
   * incremental owner index cannot represent. Ordinary design-system rule
   * changes are applied through the reserved design-system owner below.
   * Fallbacks are counted and named so an unmodelled input stays visible.
   */
  const rebuildAll = (fileRules, designSystemRules, reason) => {
    records.clear();
    ownerIndex.clear();
    ordered = [];
    logicalFloatCount = 0;
    identityViolation = null;
    const { constantRules } = splitConstantRules(designSystemRules);
    const { constsMap, sig } = buildConsts(constantRules);
    currentConsts = constsMap;
    constSig = sig;
    designSystemRuleKeys = new Map();

    // The design system's own rules are owned by a reserved key, so a later
    // design-system change is expressed as a normal owner change and not as a
    // special case.
    for (const [className, styleObj, priority] of designSystemRules) {
      if (styleObj?.constKey != null && styleObj?.constVal != null) continue;
      addOwner(DESIGN_SYSTEM_OWNER, className, styleObj, priority, true);
      designSystemRuleKeys.set(className, {
        signature: signatureOfRule(styleObj, priority),
        styleObj,
        priority,
      });
    }
    for (const [file, rules] of fileRules) {
      for (const [className, styleObj, priority] of rules) {
        if (styleObj?.constKey != null && styleObj?.constVal != null) continue;
        addOwner(file, className, styleObj, priority, true);
      }
    }
    // One sort, not one insertion per rule. Inserting 10,000 rules into a
    // growing array one at a time is quadratic and would make the FALLBACK
    // slower than the thing it is a fallback for.
    ordered.sort((a, b) => compare(tupleOf(a), tupleOf(b)));
    totals.fallbacks += 1;
    totals.lastFallbackReason = reason;
    groups = [];
    lastCss = null;
  };

  // ------------------------------------------------------------ serialize ----

  const sameGroupMembers = (group, start, end) => {
    if (group.members === undefined || group.members.length !== end - start) {
      return false;
    }
    for (let i = start; i < end; i++) {
      if (group.members[i - start] !== ordered[i]) return false;
    }
    return true;
  };

  const collectGroup = (start, end, index) => {
    const parts = [];
    const seen = new Set();
    // The aggregator's own dedup: keyed by class name, and already guaranteed
    // unique here because `records` is keyed by it.
    for (let i = start; i < end; i++) {
      const record = ordered[i];
      if (seen.has(record.className)) continue;
      seen.add(record.className);
      for (const text of transform(
        { ltr: record.ltr, rtl: record.rtl },
        index,
        config,
      )) {
        parts.push(text);
      }
    }
    return parts.join('\n');
  };

  const layerableOf = (start, end) => {
    const parts = [];
    for (let i = start; i < end; i++) {
      if (ordered[i].priority <= 0) continue;
      for (const text of transform(
        { ltr: ordered[i].ltr, rtl: ordered[i].rtl },
        0,
        config,
      )) {
        parts.push(text);
      }
    }
    return parts;
  };

  const unlayeredOf = (start, end) => {
    const parts = [];
    for (let i = start; i < end; i++) {
      if (ordered[i].priority !== 0) continue;
      for (const text of transform(
        { ltr: ordered[i].ltr, rtl: ordered[i].rtl },
        0,
        config,
      )) {
        parts.push(text);
      }
    }
    return parts;
  };

  const rawUseLayers =
    typeof config === 'boolean' ? config : ((config ?? {}).useLayers ?? false);
  const useLayers = rawUseLayers !== false;
  const layerNameForIndex = (index) => {
    const prefix =
      typeof rawUseLayers === 'object' ? (rawUseLayers.prefix ?? '') : '';
    return prefix ? `${prefix}.priority${index + 1}` : `priority${index + 1}`;
  };

  /**
   * The current stylesheet.
   *
   * Split into the part that is O(changed rules) - ordering maintenance and
   * re-serialising the layer groups whose membership changed - and the part that
   * is O(bytes) - joining the group texts into the single file that is actually
   * published. The two are timed separately, because they have different
   * scaling behaviour and only one of them is a candidate for a further fix.
   */
  const serialize = () => {
    const orderStart = perfNow();
    const nextGroups = [];
    let start = 0;
    for (let i = 1; i <= ordered.length; i++) {
      const boundary =
        i === ordered.length ||
        Math.floor(ordered[i].priority / 1000) !==
          Math.floor(ordered[start].priority / 1000);
      if (!boundary) continue;
      nextGroups.push({
        start,
        end: i,
        level: Math.floor(ordered[start].priority / 1000),
      });
      start = i;
    }
    // Reuse a group's text only when its MEMBERS are unchanged, so an insert
    // that moves a rule between groups re-serialises exactly the two groups it
    // touched and leaves the other thousand alone.
    const reuse = new Array(nextGroups.length).fill(false);
    if (groups.length === nextGroups.length) {
      for (let g = 0; g < nextGroups.length; g++) {
        reuse[g] =
          groups[g].text != null &&
          sameGroupMembers(groups[g], nextGroups[g].start, nextGroups[g].end);
      }
    }
    const orderNs = perfNow() - orderStart;

    const serializeStart = perfNow();
    for (let g = 0; g < nextGroups.length; g++) {
      if (reuse[g]) {
        nextGroups[g].members = groups[g].members;
        nextGroups[g].text = groups[g].text;
        nextGroups[g].wrapped = groups[g].wrapped;
        continue;
      }
      const { start: s, end: e } = nextGroups[g];
      nextGroups[g].members = ordered.slice(s, e);
      let text = collectGroup(s, e, g);
      if (useLayers) {
        // A priority level can mix rules that must stay outside layers
        // (`@property`, `@keyframes`, `@position-try` are all priority 0) with
        // rules that belong inside them (custom properties are priority 1), so
        // the group is partitioned by each rule's own priority.
        const parts = [];
        const unlayered = unlayeredOf(s, e).join('\n');
        const layerable = layerableOf(s, e).join('\n');
        if (unlayered.length > 0) parts.push(unlayered);
        if (layerable.length > 0) {
          parts.push(`@layer ${layerNameForIndex(g)}{\n${layerable}\n}`);
        }
        text = parts.join('\n');
      } else {
        text = collectGroup(s, e, g);
      }
      nextGroups[g].text = text;
    }

    const logicalFloatVars =
      logicalFloatCount > 0
        ? computeLogicalFloatVars(
            ordered.map((r) => [
              r.className,
              { ltr: r.ltr, rtl: r.rtl },
              r.priority,
            ]),
          )
        : '';
    const header = layerHeader(config, nextGroups.length);
    const collectedCSS = nextGroups.map((g) => g.text).join('\n');
    const serializeNs = perfNow() - serializeStart;
    groups = nextGroups;

    const css = logicalFloatVars + header + collectedCSS;
    const reused = Math.max(0, ordered.length - revision.rulesAdded);
    lastCss = css;
    count('css_rules_reused', reused);
    count('css_rules_added', revision.rulesAdded);
    count('css_rules_removed', revision.rulesRemoved);
    count('css_rules_refcount_changed', revision.refcountChanged);
    return {
      css,
      orderNs,
      serializeNs,
      ruleCount: ordered.length,
      ownerCount: ownerIndex.size,
      groupCount: nextGroups.length,
    };
  };

  return {
    /**
     * Brings the state to the revision being published.
     *
     * @param fileRules        every covered file's contribution, for a rebuild.
     * @param designSystemRules the design system's injected rules. Their
     *                         owner is diffed incrementally when the constant
     *                         substitution table is stable.
     * @param changedFiles     files recompiled this revision, and their NEW
     *                         contributions. `undefined` forces a rebuild.
     * @param liveOwners       every file that currently owns a contribution.
     *                          This, not a list of departures, is what decides
     *                          ownership: a file stops owning a rule by DELETION,
     *                          by leaving the covered set, or by failing to
     *                          compile, and a list of the first of those misses
     *                          the other two. Anything the state knows about that
     *                          is not here is retired.
     * @param fallback         `true`, or a reason string, to rebuild.
     */
    apply({
      fileRules,
      designSystemRules,
      changedFiles,
      liveOwners,
      fallback = null,
    }) {
      const start = perfNow();
      revision = {
        rulesAdded: 0,
        rulesRemoved: 0,
        refcountChanged: 0,
        orderInserted: 0,
        orderRemoved: 0,
      };
      if (identityViolation != null) {
        fallback = fallback ?? 'css-rule-identity-violated';
        identityViolation = null;
      }
      let nextConsts = null;
      if (fallback == null && designSystemRules != null && constSig != null) {
        const { constantRules } = splitConstantRules(designSystemRules);
        nextConsts = buildConsts(constantRules);
        if (nextConsts.sig !== constSig)
          fallback = 'design-system-constant-set';
      }
      const mustRebuild =
        fallback != null ||
        changedFiles == null ||
        constSig == null ||
        currentConsts == null;
      if (mustRebuild) {
        const reason = fallback ?? 'initial';
        rebuildAll(fileRules ?? new Map(), designSystemRules, reason);
        count('css_full_fallback', 1);
        return { fallback: true, reason, ns: perfNow() - start };
      }

      if (nextConsts != null) currentConsts = nextConsts.constsMap;
      updateDesignSystemOwner(designSystemRules ?? []);
      for (const [file, rules] of changedFiles) setFile(file, rules);
      if (identityViolation != null) {
        const reason = 'css-rule-identity-violated';
        rebuildAll(fileRules ?? new Map(), designSystemRules, reason);
        count('css_full_fallback', 1);
        return { fallback: true, reason, ns: perfNow() - start };
      }

      // Retire every owner that is not live any more. O(owners), not O(rules):
      // a project that did not change pays one Set lookup per file and no rule
      // work at all.
      if (liveOwners != null) {
        for (const owner of [...ownerIndex.keys()]) {
          if (owner === DESIGN_SYSTEM_OWNER) continue;
          if (!liveOwners.has(owner)) dropOwner(owner);
        }
      }
      return { fallback: false, reason: null, ns: perfNow() - start };
    },

    serialize,

    /** Counters, for the build report and the benchmark rows. */
    stats() {
      return {
        ...revision,
        fallbacks: totals.fallbacks,
        fallbackReason: totals.lastFallbackReason,
        ruleRecords: records.size,
        ownerCount: ownerIndex.size,
        lastCss,
      };
    },

    /**
     * owner key -> the class names it owns. Exposed so a test can assert the
     * OWNERSHIP graph directly, rather than inferring it from what happened to
     * appear in the stylesheet.
     */
    ownership() {
      const out = {};
      for (const [owner, classNames] of ownerIndex) {
        out[owner] = [...classNames];
      }
      return out;
    },

    /** record -> its owners, for the shared-atom assertions. */
    ownersOf(className) {
      const record = records.get(className);
      return record == null ? null : [...record.owners];
    },

    /** Exposed for the tests: the sorted class names. */
    orderedClassNames() {
      return ordered.map((r) => r.className);
    },
  };
}

export { DESIGN_SYSTEM_OWNER };
