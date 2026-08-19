/*
 * examples/datasets.js — shared demo dataset presets.
 *
 * A dataset is `gantt.service("stargantt.data").load()`'s first argument:
 *   { tasks, links?, resources?, assignments?, calendars? }
 * Every preset carries the full capability set — links, resources, assignments, progress and
 * cost/baseline meta fields (`meta.costTracking`, `meta.evm`, `meta.actualStart`/`actualEnd`) —
 * so applying any preset to any page yields a meaningful chart. The tracking plugin claims exactly
 * `actualStart`, `actualEnd`, `progressTracking`, `costTracking`, `evm` under `task.meta`
 * (docs/specs/plugins/tracking.md §2.1), so this file's `meta.costTracking`/`meta.evm`/
 * `meta.actualStart`/`meta.actualEnd` shapes match that contract.
 *
 * Determinism: dates are fixed offsets from the day-floored "today" anchor (the same pinned
 * pattern `examples/basic.html`/`examples/tracking.html` use; the E2E clock is fixed, so this is
 * deterministic under test). Generated presets use the inline mulberry32 PRNG below with literal
 * committed seeds. `Math.random()` and unpinned `Date.now()` variation are forbidden.
 *
 * Kept as a shared reference/dataset library, not wired into any page via `<script src>`: the
 * example pages follow the self-contained pattern established by `examples/basic.html` etc.
 * (inline `<style>`, inline dataset functions) rather than a shared playground shell with a live
 * Data-selector/Code-drawer. A page MAY still load this file directly
 * (`<script src="./datasets.js"></script>`, exposing `window.StarGanttDemoPresets`) if it wants a
 * larger/domain-flavored dataset than its own inline generator.
 */
(function () {
  "use strict";

  var DAY = 86400000;
  // Day-floored anchor: stable within a day, pinned under the fixed E2E clock.
  var T0 = Math.floor(Date.now() / DAY) * DAY;

  /** mulberry32 — tiny deterministic PRNG; seed and algorithm are part of the preset contract. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function day(n) {
    return T0 + n * DAY;
  }

  // ------------------------------------------------------------------ small (8 tasks)

  function buildSmall() {
    return {
      tasks: [
        { id: "p", parentId: null, name: "Product launch", type: "summary", start: day(0), end: day(26) },
        { id: "s1", parentId: "p", name: "Requirements", start: day(0), end: day(4), progress: 1,
          meta: { costTracking: { fixedCost: 1200, actualCost: 1250 }, evm: { bac: 1200, actualCost: 1250 }, actualStart: day(0), actualEnd: day(4) } },
        { id: "s2", parentId: "p", name: "Design", start: day(4), end: day(9), progress: 0.8,
          meta: { costTracking: { fixedCost: 2400, actualCost: 1900 }, evm: { bac: 2400, actualCost: 1900 }, actualStart: day(4) } },
        { id: "s3", parentId: "p", name: "Build", start: day(9), end: day(17), progress: 0.35,
          meta: { costTracking: { fixedCost: 6400, materialCost: 800, actualCost: 2100 }, evm: { bac: 7200, actualCost: 2100 } } },
        { id: "s4", parentId: "p", name: "Verify", start: day(17), end: day(21), progress: 0,
          meta: { costTracking: { fixedCost: 1800 }, evm: { bac: 1800 } } },
        { id: "s5", parentId: "p", name: "Document", start: day(15), end: day(21), progress: 0.1,
          meta: { costTracking: { fixedCost: 900 }, evm: { bac: 900 } } },
        { id: "s6", parentId: "p", name: "Ship", type: "milestone", start: day(24), end: day(24) },
        { id: "s7", parentId: "p", name: "Retrospective", start: day(24), end: day(26) }
      ],
      links: [
        { id: "l1", sourceId: "s1", targetId: "s2", type: "FS" },
        { id: "l2", sourceId: "s2", targetId: "s3", type: "FS" },
        { id: "l3", sourceId: "s3", targetId: "s4", type: "FS" },
        { id: "l4", sourceId: "s3", targetId: "s5", type: "SS", lag: 6 * DAY },
        { id: "l5", sourceId: "s4", targetId: "s6", type: "FS" },
        { id: "l6", sourceId: "s6", targetId: "s7", type: "FS" }
      ],
      resources: [
        { id: "r1", name: "Aiko", capacity: 1 },
        { id: "r2", name: "Ben", capacity: 1 },
        { id: "r3", name: "Rig", capacity: 2 }
      ],
      assignments: [
        { taskId: "s1", resourceId: "r1", units: 1 },
        { taskId: "s2", resourceId: "r1", units: 0.5 },
        { taskId: "s2", resourceId: "r2", units: 0.5 },
        { taskId: "s3", resourceId: "r2", units: 1 },
        { taskId: "s3", resourceId: "r3", units: 1 },
        { taskId: "s4", resourceId: "r1", units: 1 },
        { taskId: "s5", resourceId: "r2", units: 0.25 }
      ]
    };
  }

  // ------------------------------------------------------------------ generated projects

  var FIRST_NAMES = ["Aiko", "Ben", "Chio", "Dev", "Emi", "Finn", "Gus", "Hana", "Ivo", "Juna"];

  /**
   * Deterministic multi-phase project generator shared by the medium/large presets.
   * `seed` is a literal committed per-preset constant.
   */
  function buildProject(seed, phaseCount, tasksPerPhase, resourceCount) {
    var rnd = mulberry32(seed);
    var tasks = [];
    var links = [];
    var resources = [];
    var assignments = [];
    var r, i, p;

    for (r = 0; r < resourceCount; r++) {
      resources.push({
        id: "res" + r,
        name: FIRST_NAMES[r % FIRST_NAMES.length] + (r >= FIRST_NAMES.length ? " " + (Math.floor(r / FIRST_NAMES.length) + 1) : ""),
        capacity: r % 4 === 3 ? 2 : 1
      });
    }

    var phaseStart = 0;
    for (p = 0; p < phaseCount; p++) {
      var pid = "ph" + p;
      var cursor = phaseStart;
      var phaseEnd = phaseStart;
      tasks.push({ id: pid, parentId: null, name: "Phase " + (p + 1), type: "summary", start: day(phaseStart), end: day(phaseStart + 1) });
      for (i = 0; i < tasksPerPhase; i++) {
        var tid = "t" + p + "-" + i;
        var dur = 2 + Math.floor(rnd() * 8);
        var gap = rnd() < 0.3 ? 1 : 0;
        var start = cursor + gap;
        var end = start + dur;
        var progress = Math.round(Math.max(0, Math.min(1, (phaseCount * tasksPerPhase * 0.55 - (p * tasksPerPhase + i)) / (phaseCount * tasksPerPhase * 0.4))) * 20) / 20;
        var bac = (dur * (400 + Math.floor(rnd() * 300)));
        var task = {
          id: tid, parentId: pid, name: "Task " + (p + 1) + "." + (i + 1),
          start: day(start), end: day(end), progress: progress,
          meta: { costTracking: { fixedCost: bac, actualCost: Math.round(bac * progress) }, evm: { bac: bac, actualCost: Math.round(bac * progress) } }
        };
        if (progress > 0) task.meta.actualStart = day(start);
        if (progress >= 1) task.meta.actualEnd = day(end);
        if (rnd() < 0.08) { task.type = "milestone"; task.start = task.end = day(end); delete task.progress; }
        tasks.push(task);
        if (i > 0 && rnd() < 0.75) {
          links.push({ id: "l" + tid, sourceId: "t" + p + "-" + (i - 1), targetId: tid, type: rnd() < 0.85 ? "FS" : "SS" });
          cursor = end;
        } else if (i > 0) {
          cursor = Math.max(cursor, start + Math.floor(dur / 2));
        } else {
          cursor = end;
        }
        phaseEnd = Math.max(phaseEnd, end);
        assignments.push({ taskId: tid, resourceId: "res" + ((p * tasksPerPhase + i) % resourceCount), units: rnd() < 0.25 ? 0.5 : 1 });
        if (rnd() < 0.2) {
          assignments.push({ taskId: tid, resourceId: "res" + ((p * tasksPerPhase + i + 1) % resourceCount), units: 0.5 });
        }
      }
      // cross-phase FS link chain
      if (p > 0) {
        links.push({ id: "lph" + p, sourceId: "t" + (p - 1) + "-" + (tasksPerPhase - 1), targetId: "t" + p + "-0", type: "FS" });
      }
      // summary bounds
      var phTask = tasks.filter(function (t) { return t.id === pid; })[0];
      phTask.start = day(phaseStart);
      phTask.end = day(phaseEnd);
      phaseStart = phaseStart + Math.max(2, Math.floor((phaseEnd - phaseStart) * 0.6));
    }
    return { tasks: tasks, links: links, resources: resources, assignments: assignments };
  }

  // ------------------------------------------------------------------ domain variants

  function domainProject(names, seed) {
    var rnd = mulberry32(seed);
    var tasks = [];
    var links = [];
    var resources = names.resources.map(function (n, idx) {
      return { id: "r" + idx, name: n, capacity: 1 };
    });
    var assignments = [];
    var cursor = 0;
    names.phases.forEach(function (phase, p) {
      var pid = "g" + p;
      var phaseStart = cursor;
      var phaseEnd = cursor;
      tasks.push({ id: pid, parentId: null, name: phase.name, type: "summary", start: day(phaseStart), end: day(phaseStart + 1) });
      var prev = null;
      phase.tasks.forEach(function (name, i) {
        var tid = "g" + p + "-" + i;
        var dur = 2 + Math.floor(rnd() * 6);
        var start = prev === null ? phaseStart : cursor;
        var end = start + dur;
        var done = p === 0 || (p === 1 && i < phase.tasks.length / 2);
        var progress = done ? 1 : p === 1 ? 0.5 : 0;
        var bac = dur * (500 + Math.floor(rnd() * 250));
        var task = {
          id: tid, parentId: pid, name: name, start: day(start), end: day(end), progress: progress,
          meta: { costTracking: { fixedCost: bac, actualCost: Math.round(bac * progress) }, evm: { bac: bac, actualCost: Math.round(bac * progress) } }
        };
        if (progress > 0) task.meta.actualStart = day(start);
        if (progress >= 1) task.meta.actualEnd = day(end);
        tasks.push(task);
        if (prev) links.push({ id: "l" + tid, sourceId: prev, targetId: tid, type: "FS" });
        assignments.push({ taskId: tid, resourceId: "r" + ((p + i) % resources.length), units: 1 });
        prev = tid;
        cursor = end;
        phaseEnd = Math.max(phaseEnd, end);
      });
      tasks.filter(function (t) { return t.id === pid; })[0].end = day(phaseEnd);
      tasks.filter(function (t) { return t.id === pid; })[0].start = day(phaseStart);
      if (p > 0) links.push({ id: "lg" + p, sourceId: "g" + (p - 1) + "-" + (names.phases[p - 1].tasks.length - 1), targetId: "g" + p + "-0", type: "FS" });
      cursor = phaseEnd;
    });
    var milestone = { id: "gm", parentId: null, name: names.milestone, type: "milestone", start: day(cursor), end: day(cursor) };
    tasks.push(milestone);
    links.push({ id: "lgm", sourceId: "g" + (names.phases.length - 1) + "-" + (names.phases[names.phases.length - 1].tasks.length - 1), targetId: "gm", type: "FS" });
    return { tasks: tasks, links: links, resources: resources, assignments: assignments };
  }

  var CONSTRUCTION = {
    resources: ["Site crew", "Electricians", "Plumbers", "Inspector"],
    milestone: "Handover",
    phases: [
      { name: "Groundwork", tasks: ["Survey site", "Excavate", "Pour foundation", "Cure & inspect"] },
      { name: "Structure", tasks: ["Frame walls", "Roof trusses", "Windows & doors", "Exterior cladding"] },
      { name: "Systems", tasks: ["Rough electrical", "Rough plumbing", "HVAC install", "Insulation"] },
      { name: "Finish", tasks: ["Drywall", "Paint", "Flooring", "Fixtures", "Final inspection"] }
    ]
  };

  var SOFTWARE = {
    resources: ["Backend team", "Frontend team", "QA", "DevOps"],
    milestone: "GA release",
    phases: [
      { name: "Discovery", tasks: ["User interviews", "Spec draft", "Spec review"] },
      { name: "Alpha", tasks: ["API skeleton", "Data model", "UI shell", "CI pipeline"] },
      { name: "Beta", tasks: ["Feature complete", "Perf pass", "Bug triage", "Beta program"] },
      { name: "Release", tasks: ["Docs", "Security review", "Release candidate", "Launch checklist"] }
    ]
  };

  var MARKETING = {
    resources: ["Copywriter", "Designer", "Media buyer"],
    milestone: "Campaign live",
    phases: [
      { name: "Research", tasks: ["Audience analysis", "Competitor scan", "Message testing"] },
      { name: "Production", tasks: ["Copy draft", "Visual identity", "Landing page", "Ad variants"] },
      { name: "Launch prep", tasks: ["Channel plan", "Budget sign-off", "Schedule posts"] }
    ]
  };

  // ------------------------------------------------------------------ registry

  window.StarGanttDemoPresets = {
    presets: [
      { id: "small", label: "Small (8 tasks)", build: buildSmall },
      { id: "medium", label: "Medium (~60 tasks)", build: function () { return buildProject(0x5ee1, 6, 9, 6); } },
      { id: "large", label: "Large (~1,000 tasks)", build: function () { return buildProject(0xba5e, 40, 24, 20); } },
      { id: "construction", label: "Construction project", build: function () { return domainProject(CONSTRUCTION, 0xc0de); } },
      { id: "software", label: "Software release", build: function () { return domainProject(SOFTWARE, 0x50f7); } },
      { id: "marketing", label: "Marketing campaign", build: function () { return domainProject(MARKETING, 0x3a2b); } }
    ]
  };
})();
