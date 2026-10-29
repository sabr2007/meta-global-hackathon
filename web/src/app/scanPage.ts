// One mirror: the photo and its physical twin on the stage, Ayna's run on the panel.
// Live runs call Meta models through the server (open to everyone, within a daily allowance); saved
// runs replay for free: the models' outputs come from the run record and the robots re-run in the twin.

import { models, scans, verdict as sparkVerdict, type RunCard, type Session, type User } from '../ayna/client';
import type { ObjectGoal } from '../ayna/goals';
import { receiptLine, refusedInEdit, runAyna, type RunHooks } from '../ayna/pipeline';
import { silhouette } from '../ayna/raster';
import type { RunRecord } from '../ayna/record';
import { execute, type Imagined, type TraceEvent } from '../ayna/run';
import { bodyPose, measure, type BodyPose, type Receipt } from '../ayna/verify';
import { fleetPanel, type FleetPanel } from './fleetPanel';
import { h, historyStrip, receiptCard, stepsList, timeline, versions, type VersionView } from './panel';
import { createStage, type InkLayer } from './stage';
import { loadTwin, type Twin } from './twin';
import { startRecording, type Recording } from './voice';


const SUGGESTIONS = ['Tidy up my desk', 'Clear the front half of the table', 'Group the orange toys together', 'Line the small things up along the back'];
const REPLAY_SPEED = 3; // replays play the recorded model timeline this many times faster
const REPLAY_MAX_WAIT_MS = 1400;
const REVIEW_AUTOPLAY_MS = 3200;

interface PageOptions {
  user: User | null;
  autoplay: boolean;
  runId?: string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));


const ONE_TAKE_SPEED = 3;
export async function scanPage(root: HTMLElement, session: Session, owner: string, id: string, options: PageOptions): Promise<() => void> {
  const { meta, files, live } = await scans.open(session, owner, id);
  if (meta.status !== 'ready') {
    const card = h('section', 'pending card');
    card.setAttribute('role', 'status');
    const words: Record<string, string> = {
      queued: 'Waiting for the scan builder. It turns the iPhone capture into a twin; this page fills in when it is done.',
      processing: 'Building the twin: objects, masks, SAM 3D meshes and robots. A new scan takes about three minutes.',
      failed: `The build failed: ${meta.error ?? 'no reason given'}. Send the scan again from the iPhone.`,
    };
    const back = h('a', 'pill pill--outline', 'Back to mirrors');
    back.href = '#/';
    card.append(h('span', `tag ${meta.status === 'failed' ? 'tag--orange' : ''}`, meta.status), h('h1', 'title', meta.name), h('p', '', words[meta.status] ?? ''), back);
    root.replaceChildren(card);
    if (meta.status !== 'failed') {
      const timer = setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 15_000);
      return () => clearTimeout(timer);
    }
    return () => undefined;
  }
  const page = h('section', 'scan');
  page.setAttribute('aria-labelledby', 'scan-title');
  const panel = h('aside', 'scan__panel');
  const head = h('header', 'scan__head');
  const title = h('h1', 'title scan__title', meta.name);
  title.id = 'scan-title';
  const facts = h('p', 'scan__facts');
  const robotsTag = h('span', 'tag', `${meta.robots || 1} robot${meta.robots > 1 ? 's' : ''}`);
  facts.append(h('span', 'tag', `${meta.objects} objects`), robotsTag, h('span', `tag ${live ? 'tag--lime' : ''}`, live ? 'live models' : 'replays only'));
  head.append(h('span', 'eyebrow', 'Mirror'), title, facts);

  // Composer: voice or text.
  const composer = h('form', 'composer');
  composer.setAttribute('aria-label', 'Ask Ayna');
  const mic = h('button', 'composer__mic');
  mic.type = 'button';
  mic.setAttribute('aria-label', 'Hold to speak (Muse Voice Transcribe)');
  mic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const input = h('input', 'composer__input');
  input.type = 'text';
  input.name = 'request';
  input.placeholder = 'Say or type: “tidy up my desk”';
  input.setAttribute('aria-label', 'What should the table look like?');
  input.autocomplete = 'off';
  const go = h('button', 'pill pill--lime composer__go', 'Imagine');
  go.type = 'submit';
  composer.append(mic, input, go);
  const chips = h('div', 'chips');
  for (const text of SUGGESTIONS) {
    const chip = h('button', 'pill pill--small pill--outline', text);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      input.value = text;
      input.focus();
    });
    chips.append(chip);
  }
  const guest = h('p', 'scan__guest');
  guest.textContent = live ? '' : 'Live runs open once this twin is built. Saved runs replay below — free, no model calls.';

  const log = timeline();
  const logBlock = h('section', 'block');
  logBlock.append(h('h2', 'eyebrow block__title', 'What the models are doing'), log.root);
  const versionsBlock = h('section', 'block');
  versionsBlock.hidden = true;
  // While the after photo waits for approval, clicking another version that passed picks it instead.
  let picker: ((id: string) => void) | null = null;
  const versionList = versions((vid) => {
    void showVersion(vid);
    picker?.(vid);
  });
  versionsBlock.append(h('h2', 'eyebrow block__title', 'Developed after photos · SAM 3.1 check'), versionList.root);
  const review = h('section', 'block review');
  review.hidden = true;
  const planBlock = h('section', 'block');
  planBlock.hidden = true;
  const receiptSlot = h('div', 'receipt-slot');
  const historyBlock = h('section', 'block');
  const historyTitle = h('h2', 'eyebrow block__title', 'Runs on this mirror');
  historyBlock.append(historyTitle);
  panel.append(head, ...(live ? [composer, chips] : [guest]), logBlock, versionsBlock, review, planBlock, receiptSlot, historyBlock);

  // Stage + twin.
  const sceneFiles = files;
  const photoMeta = (await (await fetch(sceneFiles['scene.json'])).json()) as { camera: { width: number; height: number } };
  const stage = createStage(sceneFiles['hero.jpg'], photoMeta.camera);
  const stageWrap = h('div', 'scan__stage');
  stageWrap.append(stage.root);
  page.append(stageWrap, panel);
  root.replaceChildren(page);
  stage.setMode('photo');
  stage.setCaption('Loading the physical twin…');

  let twin: Twin;
  try {
    twin = await loadTwin(stage.canvas, sceneFiles);
  } catch (error) {
    stage.setCaption(error instanceof Error ? error.message : 'The twin failed to load', 'orange');
    throw error;
  }
  stage.setCaption(`Real photo · SAM 3.1 found ${twin.objects.length} objects`);
  if (import.meta.env.DEV) Object.assign(window, { __ayna: { twin, stage } });
  const fleet: FleetPanel = fleetPanel(twin, stage);
  panel.insertBefore(fleet.root, historyBlock);
  robotsTag.textContent = `${twin.robots.robots.length} robot${twin.robots.robots.length === 1 ? '' : 's'}`;
  stage.setInk(twin.before.map((b) => ({ key: b.object, rle: b.rle, style: 'found' })));

  // In the one-take (?autoplay) the panel follows the run, so a screen recording needs no scrolling.
  // On a phone the stage and the panel stack, so while the robots work the stage stays in view instead.
  const narrow = (): boolean => window.matchMedia('(max-width: 980px)').matches;
  let acting = false;
  const reveal = (node: HTMLElement): void => {
    if (options.autoplay && !node.hidden && !(acting && narrow())) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const versionImages = new Map<string, string>();
  const versionViews = new Map<string, VersionView>();
  const goalsByVersion = new Map<string, ObjectGoal[]>();
  let busy = false;

  const renderVersions = (): void => {
    const appearing = versionsBlock.hidden && versionViews.size > 0;
    versionsBlock.hidden = versionViews.size === 0;
    versionList.set([...versionViews.values()]);
    if (appearing) reveal(versionsBlock);
  };

  async function showVersion(vid: string): Promise<void> {
    const image = versionImages.get(vid);
    if (!image) return;
    stage.setMode('photo');
    await stage.showAfter(image, false);
    const view = versionViews.get(vid);
    const goals = goalsByVersion.get(vid);
    const ink: InkLayer[] = goals ? goals.filter((g) => g.mask).map((g) => ({ key: g.name, rle: g.mask!, style: 'ghost' })) : [];
    if (view && !view.passed) {
      for (const b of twin.before) {
        if (view.reasons.some((r) => r.startsWith(twin.objects.find((o) => o.name === b.object)?.label ?? '~'))) ink.push({ key: b.object, rle: b.rle, style: 'miss', label: 'missing / changed' });
      }
    }
    stage.setInk(ink);
    stage.setCaption(view?.passed ? `Imagined · version ${vid.toUpperCase()} kept every object` : `Imagined · version ${vid.toUpperCase()} rejected: ${view?.reasons[0] ?? ''}`, view?.passed ? 'lime' : 'orange');
  }

  const resetTwin = async (): Promise<void> => {
    twin.physics.reset();
    twin.fleet.forEach((r) => r.reset());
    await twin.settle(0.5);
  };

  const robotLabel = (rid: string): string => twin.fleet.find((r) => r.id === rid)?.label ?? rid;

  /** After the robots: back into the photo, imagined contours vs where the robots put things. */
  const showResult = async (receipt: Receipt, goals: ObjectGoal[], afterUrl: string): Promise<void> => {
    await twin.fly('photo');
    stage.setMode('photo');
    await stage.showAfter(afterUrl, false);
    stage.setSlider(false);
    const ink: InkLayer[] = [];
    for (const goal of goals) {
      if (goal.mask && goal.moves) ink.push({ key: `${goal.name}-goal`, rle: goal.mask, style: 'ghost' });
      const mesh = twin.meshes.get(goal.name);
      const result = receipt.results.find((r) => r.name === goal.name);
      if (mesh && result && goal.moves) {
        ink.push({ key: `${goal.name}-sim`, rle: silhouette(twin.camera, mesh, bodyPose(twin.physics, goal.name)), style: result.ok ? 'match' : 'miss', label: `${(result.errorM * 100).toFixed(1)} cm` });
      }
    }
    stage.setInk(ink);
    stage.setCaption(`Robots' result over the imagined photo · ${receipt.moved.done}/${receipt.moved.asked} moves done`, receipt.score >= 80 ? 'lime' : 'orange');
    stage.setScore(receipt.score);
    twin.speed = 1;
    acting = false;
  };

  const refreshHistory = async (): Promise<RunCard[]> => {
    const { runs } = await scans.runs(session, owner, id);
    historyBlock.replaceChildren(historyTitle, historyStrip(runs, (rid) => void replay(rid, false)));
    return runs;
  };

  const startRun = (): void => {
    busy = true;
    fleet.setBusy(true);
    composer.classList.add('is-busy');
    go.disabled = true;
    mic.disabled = true;
    log.clear();
    versionViews.clear();
    versionImages.clear();
    goalsByVersion.clear();
    renderVersions();
    review.hidden = true;
    planBlock.hidden = true;
    receiptSlot.replaceChildren();
    stage.setSlider(false);
    stage.setScore(null);
  };
  const endRun = (): void => {
    busy = false;
    fleet.setBusy(false);
    composer.classList.remove('is-busy');
    go.disabled = false;
    mic.disabled = false;
  };
  /** A run that breaks says why, in the log and on the stage, instead of going quiet. */
  const failRun = (error: unknown): void => {
    const text = `The run stopped: ${error instanceof Error ? error.message : String(error)}`;
    log.add({ step: 'verify', state: 'fail', text });
    stage.setCaption(text, 'orange');
  };

  const traceToUi = (event: TraceEvent): void => {
    log.add(event);
    if (event.step === 'imagine' && event.state === 'done' && event.candidate && event.image) {
      versionImages.set(event.candidate, event.image);
      versionViews.set(event.candidate, { id: event.candidate, image: event.image, passed: false, reasons: ['checking…'], chosen: false });
      renderVersions();
      if (versionViews.size === 1) {
        stage.setCaption(`Muse Image is developing version ${event.candidate.toUpperCase()}`);
        void stage.showAfter(event.image, true);
        stage.setInk([]);
      }
    }
    if (event.step === 'check' && event.candidate && event.check) {
      const view = versionViews.get(event.candidate);
      if (view) {
        view.passed = event.check.passed;
        view.reasons = event.check.reasons;
        renderVersions();
      }
    }
    if (event.step === 'plan' && event.state === 'start') stage.setCaption('Muse Spark is planning the robots');
  };

  /** Show the chosen version, the slider and wait for "Do it". */
  const approveStep = (
    chosenId: string,
    summary: string,
    refusals: { object: string; reason: string }[],
    auto: boolean,
    alternatives: string[] = [],
    canRedraw = false,
  ): Promise<boolean | string | { redraw: string }> => {
    const mark = (id: string): void => {
      for (const v of versionViews.values()) v.chosen = v.id === id;
      renderVersions();
    };
    mark(chosenId);
    void showVersion(chosenId);
    stage.setSlider(true);
    stage.setCaption('Before · after — drag to compare', 'lime');
    review.hidden = false;
    review.replaceChildren();
    const text = h('p', 'review__summary', summary);
    review.append(h('h2', 'eyebrow block__title', 'The plan, as a picture'), text);
    if (alternatives.length) review.append(h('p', 'review__hint', `Muse Spark picked version ${chosenId.toUpperCase()}. Click another version that passed to plan from it instead.`));
    if (refusals.length) {
      const list = h('ul', 'review__refusals');
      for (const r of refusals) list.append(h('li', '', `${twin.objects.find((o) => o.name === r.object)?.label ?? r.object}: ${r.reason}`));
      review.append(list);
    }
    // On a phone the after photo and its slider are on the stage, above the panel: show them first.
    if (narrow()) stageWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else reveal(review);
    // On a phone the answer floats at the bottom of the screen, so it stays next to the after photo above.
    const actions = h('div', `review__actions${narrow() ? ' review__actions--floating' : ''}`);
    const yes = h('button', 'pill pill--lime', 'Do it');
    yes.type = 'button';
    const no = h('button', 'pill pill--outline', 'Not this');
    no.type = 'button';
    actions.append(yes, no);
    review.append(actions);
    let pending = chosenId;
    picker = (id) => {
      if (id === pending || (id !== chosenId && !alternatives.includes(id))) return;
      pending = id;
      mark(id);
      text.textContent = id === chosenId ? summary : `You picked version ${id.toUpperCase()}; Muse Spark preferred ${chosenId.toUpperCase()}. “Do it” plans from your pick.`;
    };
    return new Promise((resolve) => {
      const finish = (answer: boolean | string | { redraw: string }): void => {
        actions.remove();
        stage.setSlider(false);
        picker = null;
        resolve(answer);
      };
      const done = (ok: boolean): void => finish(ok && pending !== chosenId ? pending : ok);
      yes.addEventListener('click', () => done(true));
      // Live, "Not this" asks what should change: Spark rewrites the edit with it and Muse Image draws again.
      const askWhy = (): void => {
        const form = h('form', 'review__why');
        const field = h('input', 'review__why-input');
        field.type = 'text';
        field.placeholder = 'What should change? e.g. keep the cylinder where it is';
        field.setAttribute('aria-label', 'What should change in the after photo');
        const redraw = h('button', 'pill pill--lime', 'Draw again');
        redraw.type = 'submit';
        const stop = h('button', 'pill pill--outline', 'Stop');
        stop.type = 'button';
        form.append(field, redraw, stop);
        actions.replaceChildren(form);
        field.focus({ preventScroll: true });
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const why = field.value.trim();
          finish(why ? { redraw: why } : false);
        });
        stop.addEventListener('click', () => finish(false));
      };
      no.addEventListener('click', () => (canRedraw ? askWhy() : done(false)));
      if (auto) setTimeout(() => done(true), REVIEW_AUTOPLAY_MS);
      else yes.focus({ preventScroll: true });
    });
  };

  const beginExecution = async (steps: RunRecord['steps'], refusals: RunRecord['refusals']): Promise<ReturnType<typeof stepsList>> => {
    planBlock.hidden = false;
    const list = stepsList(steps, refusals, robotLabel);
    planBlock.replaceChildren(h('h2', 'eyebrow block__title', `Muse Spark's plan · ${steps.length} step${steps.length === 1 ? '' : 's'}`), list.root);
    if (narrow()) {
      acting = true;
      stageWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else reveal(planBlock);
    stage.setInk([]);
    await stage.showAfter(null);
    stage.setMode('twin');
    stage.setCaption('Out of the photo, into the twin');
    await twin.fly('orbit');
    // The one-take shows the robots at three times real speed, and says so.
    twin.speed = options.autoplay ? ONE_TAKE_SPEED : 1;
    stage.setCaption(twin.speed > 1 ? `Robots at work · live physics · ${twin.speed}× speed` : 'Robots at work · live physics');
    return list;
  };

  const markStep = (list: ReturnType<typeof stepsList> | null, event: TraceEvent): void => {
    if (!list || event.step !== 'execute' || event.state === 'start') return;
    const label = event.text.split(':')[1]?.split(' — ')[0]?.trim();
    const object = twin.objects.find((o) => o.label === label)?.name;
    if (object) list.mark(object, event.state === 'done', event.text.split(' — ')[1] ?? '');
  };

  async function runLive(request: string, source: RunRecord['source'], transcript?: string): Promise<void> {
    if (busy || !request.trim()) return;
    startRun();
    let list: ReturnType<typeof stepsList> | null = null;
    const hooks: RunHooks = {
      trace: (event) => {
        traceToUi(event);
        markStep(list, event);
      },
      approve: async (imagined: Imagined) => {
        for (const c of imagined.candidates) goalsByVersion.set(c.id, c.check.goals);
        const passed = imagined.candidates.filter((c) => c.check.passed && c.id !== imagined.chosen!.id).map((c) => c.id);
        return approveStep(imagined.chosen!.id, imagined.instruction.summary, imagined.instruction.refusals, false, passed, true);
      },
      onPlan: async (planned) => {
        list = await beginExecution(planned.steps, planned.refusals);
      },
      drive: async (work) => work,
      settle: (seconds) => twin.settle(seconds),
      render: async () => twin.renderFromPhoto(),
      verdict: (input) => sparkVerdict(session, input),
    };
    try {
      await resetTwin();
      const scene = { ctx: { camera: twin.camera, photo: await photoDataUrl(), objects: twin.objects, before: twin.before }, physics: twin.physics, fleet: twin.fleet, meshes: twin.meshes };
      const out = await runAyna(scene, request, models(session), hooks, source);
      if (transcript) out.record.transcript = transcript;
      if (out.receipt && out.imagined?.chosen) {
        await showResult(out.receipt, out.imagined.chosen.check.goals, out.imagined.chosen.image);
        receiptSlot.replaceChildren(receiptCard(out.receipt, { seconds: out.record.durationMs / 1000, costUsd: out.record.costUsd, verdict: out.record.verdict?.verdict ?? null, replay: false, usage: out.record.trace.flatMap((e) => e.usage ?? []), episodeUrl: `/api/scans/${owner}/${id}/runs/${out.record.id}/episode` }));
      } else if (out.record.status === 'no-after') {
        const stopped = out.record.feedback.at(-1)?.match(/^stopped: (.*)$/)?.[1];
        stage.setCaption(stopped ? `Muse Spark stopped: ${stopped}` : 'No imagined photo kept every object — Ayna will not plan from it', 'orange');
      } else if (out.record.error) {
        stage.setCaption(out.record.error, 'orange');
      }
      await scans.saveRun(session, owner, id, out.record, out.files).catch((error: unknown) => log.add({ step: 'verify', state: 'fail', text: `Could not save the run: ${String(error)}` }));
      await refreshHistory();
    } catch (error) {
      failRun(error);
    } finally {
      endRun();
    }
  }

  let photoCache: string | null = null;
  async function photoDataUrl(): Promise<string> {
    if (photoCache) return photoCache;
    // The stage's <img> has already cached this photo, and R2 sends CORS headers only to requests that carry
    // an Origin, so the cached copy would fail the read: fetch it from the bucket again.
    const response = await fetch(twin.photoUrl, { cache: 'reload' });
    if (!response.ok) throw new Error(`could not load the table photo (HTTP ${response.status}); reload the page`);
    const blob = await response.blob();
    photoCache = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    return photoCache;
  }

  async function replay(runId: string, auto: boolean): Promise<void> {
    if (busy) return;
    startRun();
    try {
      // The address names the run, so it can be shared; replaceState does not fire hashchange (no re-render).
      history.replaceState(null, '', `${location.pathname}${location.search}#/scan/${owner}/${id}/run/${runId}`);
      const { run, files: runFiles } = await scans.run(session, owner, id, runId);
      await resetTwin();
      const url = (file: string): string => runFiles[file] ?? '';
      log.add({ step: 'verify', state: 'info', text: `Replay of a saved run · “${run.request}” · no model calls` });
      // The recorded timeline, faster.
      let last = 0;
      const beforeApproval = run.trace.filter((e) => e.step !== 'plan' && e.step !== 'execute' && e.step !== 'verify' && e.step !== 'verdict');
      for (const event of beforeApproval) {
        await wait(Math.min((event.at - last) / REPLAY_SPEED, REPLAY_MAX_WAIT_MS));
        last = event.at;
        const candidate = run.candidates.find((c) => c.id === event.candidate);
        traceToUi({
          ...event,
          image: event.step === 'imagine' && event.state === 'done' && candidate ? url(candidate.file) : undefined,
          check: event.step === 'check' && candidate && event.state !== 'start' ? { passed: candidate.passed, reasons: candidate.reasons } : undefined,
        });
      }
      if (!run.chosen || !run.instruction) {
        stage.setCaption('This run found no imagined photo that kept every object', 'orange');
        return;
      }
      const goals: ObjectGoal[] = run.goals.map((g) => ({ ...g, source: 'concept', areaRatio: 1 }));
      goalsByVersion.set(run.chosen, goals);
      const approved = await approveStep(run.chosen, run.instruction.summary, run.instruction.refusals, auto);
      if (!approved) return;
      for (const event of run.trace.filter((e) => e.step === 'plan' && e.state !== 'start')) traceToUi(event);
      const list = await beginExecution(run.steps, run.refusals);
      const start = new Map<string, BodyPose>(twin.objects.map((o) => [o.name, bodyPose(twin.physics, o.name)]));
      const executed = await execute(run.steps, twin.fleet, (event) => {
        log.add(event);
        markStep(list, event);
      });
      await twin.settle(1);
      const notes = new Map<string, string>();
      for (const r of run.refusals) notes.set(r.object, `refused: ${r.reason}`);
      for (const e of executed) if (!e.result.ok) notes.set(e.step.object, `failed: ${e.result.reason}`);
      const receipt = measure({
        camera: twin.camera,
        goals,
        start,
        final: new Map(twin.objects.map((o) => [o.name, bodyPose(twin.physics, o.name)])),
        meshes: twin.meshes,
        beforeMasks: new Map(twin.before.map((b) => [b.object, b.rle])),
        notes,
        refusedBefore: run.instruction ? refusedInEdit(run.instruction, twin.objects) : undefined,
      });
      log.add({ step: 'verify', state: 'done', text: receiptLine(receipt) });
      const chosen = run.candidates.find((c) => c.id === run.chosen)!;
      await showResult(receipt, goals, url(chosen.file));
      window.setTimeout(() => reveal(receiptSlot), narrow() ? 2500 : 300); // on a phone, hold the result on the photo first
      receiptSlot.replaceChildren(receiptCard(receipt, { seconds: run.durationMs / 1000, costUsd: run.costUsd, verdict: run.verdict?.verdict ?? null, replay: true, usage: run.trace.flatMap((e) => e.usage ?? []), episodeUrl: `/api/scans/${owner}/${id}/runs/${runId}/episode` }));
      document.body.dataset.autoplay = 'done';
    } catch (error) {
      failRun(error);
    } finally {
      endRun();
    }
  }

  // Voice: hold the mic (or press it twice) to record; Voice Transcribe fills the request and runs it.
  let recording: Recording | null = null;
  const stopVoice = async (): Promise<void> => {
    if (!recording) return;
    const current = recording;
    recording = null;
    mic.classList.remove('is-recording');
    const wav = await current.stop();
    log.add({ step: 'listen', state: 'start', text: 'Muse Voice Transcribe is listening to your request' });
    try {
      const { text, usage } = await models(session).listen(wav);
      log.add({ step: 'listen', state: text ? 'done' : 'fail', text: text ? `“${text}”` : 'Heard nothing — try again, closer to the mic', usage });
      if (text) {
        input.value = text;
        await runLive(text, 'voice', text);
      }
    } catch (error) {
      log.add({ step: 'listen', state: 'fail', text: error instanceof Error ? error.message : String(error) });
    }
  };
  mic.addEventListener('pointerdown', async () => {
    if (busy) return;
    if (recording) {
      await stopVoice();
      return;
    }
    try {
      recording = await startRecording();
      mic.classList.add('is-recording');
    } catch {
      log.add({ step: 'listen', state: 'fail', text: 'The microphone is not available here — type the request instead' });
    }
  });
  mic.addEventListener('pointerup', () => {
    if (recording && mic.classList.contains('is-recording')) setTimeout(() => void stopVoice(), 250);
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void runLive(input.value, 'text');
  });

  const runs = await refreshHistory();
  if (options.autoplay || options.runId) {
    const pick = options.runId ?? [...runs].filter((r) => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.id;
    if (pick) await replay(pick, options.autoplay);
  }
  return () => twin.dispose();
}
