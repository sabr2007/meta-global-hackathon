// The mirror's robots: drag one onto the table or the floor and the reach map updates at once
// (objects glow lime when some robot can take them, orange with the reason when none can).

import type { Robot } from '../sim/robot';
import { h } from './panel';
import type { Stage } from './stage';
import type { Twin } from './twin';

const LIME = '#b8ff5e';
const ORANGE = '#ee7f35';

export interface FleetPanel {
  readonly root: HTMLElement;
  setBusy(busy: boolean): void;
}

export function fleetPanel(twin: Twin, stage: Stage): FleetPanel {
  const robots = twin.robots.robots;
  const root = h('section', 'block fleet');
  root.setAttribute('aria-labelledby', 'fleet-title');
  const title = h('h2', 'eyebrow block__title', 'Robots · drag one to move it');
  title.id = 'fleet-title';
  const list = h('ul', 'fleet__robots');
  const reachLine = h('p', 'fleet__summary');
  const objects = h('ul', 'fleet__objects');
  const note = h('p', 'fleet__note');
  note.setAttribute('role', 'status');
  const actions = h('div', 'fleet__actions');
  const autoPlace = h('button', 'pill pill--small pill--outline', 'Auto-place');
  autoPlace.type = 'button';
  const done = h('button', 'pill pill--small pill--lime', 'Done');
  done.type = 'button';
  done.hidden = true;
  actions.append(autoPlace, done);
  root.append(title, list, reachLine, objects, note, actions);

  let placing: Robot | null = null;
  let busy = false;
  const buttons = new Map<string, HTMLButtonElement>();
  let unsubscribe: (() => void)[] = [];

  const reachMap = (): void => {
    const colors = new Map<string, string>();
    const rows: HTMLElement[] = [];
    let reachable = 0;
    for (const object of twin.objects) {
      const checks = robots.map((r) => ({ robot: r, reach: r.reachOf(object.name) }));
      const able = checks.filter((c) => c.reach.ok);
      if (able.length) reachable += 1;
      colors.set(object.name, able.length ? LIME : ORANGE);
      const row = h('li', `fleet__object ${able.length ? '' : 'fleet__object--out'}`);
      row.append(h('span', `dot ${able.length ? 'dot--lime' : 'dot--orange'}`), h('span', 'fleet__label', object.label));
      row.append(
        h(
          'span',
          'fleet__why',
          able.length ? able.map((c) => c.robot.label).join(' · ') : checks.map((c) => `${c.robot.label}: ${c.reach.reason}`).join(' — '),
        ),
      );
      rows.push(row);
    }
    reachLine.textContent = `Reach map: ${reachable} of ${twin.objects.length} objects can be moved by some robot`;
    objects.replaceChildren(...rows);
    if (placing) twin.tintObjects(colors);
  };

  const robotRows = (): void => {
    unsubscribe.forEach((stop) => stop());
    unsubscribe = [];
    list.replaceChildren(
      ...robots.map((robot) => {
        const row = h('li', 'fleet__robot');
        const dot = h('span', `dot ${robot.status.error ? 'dot--orange' : 'dot--lime'}`);
        const status = h('span', 'fleet__status', robot.status.text);
        unsubscribe.push(
          robot.subscribe((s) => {
            status.textContent = s.text;
            dot.className = `dot ${s.error ? 'dot--orange' : 'dot--lime'}`;
          }),
        );
        const move = h('button', 'pill pill--small pill--outline', placing === robot ? 'Placing…' : 'Move');
        move.type = 'button';
        move.disabled = busy;
        move.addEventListener('click', () => void startPlacing(robot));
        buttons.set(robot.id, move);
        const name = h('span', 'fleet__name');
        name.append(h('span', '', robot.label), h('span', 'fleet__kind', robot.kind === 'mobile' ? 'drives on the floor' : 'stands on the table'));
        row.append(dot, name, status, move);
        return row;
      }),
    );
  };

  async function startPlacing(robot: Robot): Promise<void> {
    if (busy) return;
    placing = robot;
    robotRows();
    done.hidden = false;
    stage.setMode('twin');
    await stage.showAfter(null);
    await twin.fly('orbit');
    twin.setOrbitEnabled(false);
    stage.root.classList.add('stage--placing');
    stage.setCaption(`Drag on the ${robot.kind === 'mobile' ? 'floor' : 'table'} to place the ${robot.label.toLowerCase()}`, 'lime');
    note.textContent = '';
    reachMap();
  }

  const stopPlacing = (): void => {
    placing = null;
    done.hidden = true;
    stage.root.classList.remove('stage--placing');
    twin.setOrbitEnabled(true);
    twin.tintObjects(new Map());
    stage.setCaption('Twin · live physics');
    robotRows();
  };

  let frame = 0;
  const moveTo = (event: PointerEvent): void => {
    if (!placing) return;
    const robot = placing;
    const z = robot.kind === 'mobile' ? 0 : robot.basePose().z;
    const point = twin.pointOnPlane(event.clientX, event.clientY, z);
    if (!point) return;
    const yaw = Math.atan2(twin.focus[1] - point[1], twin.focus[0] - point[0]);
    const result = robot.setBasePose(point[0], point[1], yaw);
    note.textContent = result.ok ? '' : result.reason;
    note.classList.toggle('is-orange', !result.ok);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reachMap);
  };
  twin.canvas.addEventListener('pointerdown', (event) => {
    if (!placing) return;
    twin.canvas.setPointerCapture(event.pointerId);
    moveTo(event);
  });
  twin.canvas.addEventListener('pointermove', (event) => {
    if (placing && twin.canvas.hasPointerCapture(event.pointerId)) moveTo(event);
  });

  autoPlace.addEventListener('click', () => {
    for (const robot of robots) robot.setBasePose(robot.info.position[0], robot.info.position[1], robot.info.yaw);
    note.textContent = 'Back where the scan builder put them';
    note.classList.remove('is-orange');
    reachMap();
  });
  done.addEventListener('click', stopPlacing);

  robotRows();
  reachMap();
  return {
    root,
    setBusy(next) {
      busy = next;
      if (busy && placing) stopPlacing();
      for (const button of buttons.values()) button.disabled = busy;
      autoPlace.disabled = busy;
      if (!busy) reachMap();
    },
  };
}
