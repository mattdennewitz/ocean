import type { SeaSimulation } from './sea.ts';
import type { Ship, VesselSize } from './ship.ts';

const THROTTLE_RATE = 0.25;
const LOOK_SENSITIVITY = 0.003;
const LOOK_YAW_LIMIT = (110 * Math.PI) / 180;
const LOOK_UP_LIMIT = (35 * Math.PI) / 180;
const LOOK_DOWN_LIMIT = (45 * Math.PI) / 180;

interface RangeControl {
  group: HTMLDivElement;
  input: HTMLInputElement;
  output: HTMLOutputElement;
}

export class Controls {
  throttle = 0.6;
  rudder = 0;
  lookYaw = 0;
  lookPitch = 0;
  isometricView = false;
  cameraZoom = 1;

  private readonly abortController = new AbortController();
  private readonly heldKeys = new Set<string>();
  private readonly portPointers = new Set<number>();
  private readonly starboardPointers = new Set<number>();
  private readonly interfaceRoot = document.createElement('div');
  private readonly portButton: HTMLButtonElement;
  private readonly starboardButton: HTMLButtonElement;
  private readonly launchButton: HTMLButtonElement;
  private readonly viewButton: HTMLButtonElement;
  private readonly menuRevealButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly vesselSelect: HTMLSelectElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly headingValue: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly intensityRange: HTMLInputElement;
  private readonly intensityOutput: HTMLOutputElement;
  private readonly throttleRange: HTMLInputElement;
  private readonly throttleOutput: HTMLOutputElement;
  private readonly zoomRange: HTMLInputElement;
  private readonly zoomOutput: HTMLOutputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly sea: SeaSimulation;
  private readonly ship: Ship;
  private lookPointerId: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;

  constructor(canvas: HTMLCanvasElement, sea: SeaSimulation, ship: Ship) {
    this.canvas = canvas;
    this.sea = sea;
    this.ship = ship;
    const app = canvas.parentElement;
    if (!app) throw new Error('Canvas must be attached before controls are created');

    this.interfaceRoot.className = 'scene-interface';
    this.interfaceRoot.innerHTML = `
      <header class="voyage-heading" aria-label="North Sea voyage status">
        <h1>NORTH SEA</h1>
        <div class="voyage-metrics">
          <div class="voyage-metric"><span>HEADING</span><strong data-heading></strong></div>
          <div class="voyage-metric"><span>SPEED</span><strong data-speed></strong></div>
        </div>
      </header>
      <button class="menu-reveal-button" type="button" data-menu-reveal hidden>Show menu</button>
      <section class="control-panel" aria-label="Voyage controls">
        <div data-intensity></div>
        <div data-throttle></div>
        <div data-zoom></div>
        <label class="select-control">
          <span>Vessel</span>
          <select data-vessel>
            <option value="schooner">Schooner · small</option>
            <option value="trawler" selected>Trawler · medium</option>
            <option value="barge">Barge · large</option>
          </select>
        </label>
        <div class="steering-buttons">
          <button class="hold-button" type="button" data-port>Port</button>
          <button class="hold-button" type="button" data-starboard>Starboard</button>
        </div>
        <button class="secondary-button" type="button" data-center>Center view</button>
        <button class="secondary-button view-toggle-button" type="button" aria-pressed="false" data-view-toggle>Isometric view</button>
        <button class="rogue-button" type="button" data-rogue>Send rogue wave</button>
        <div class="interface-actions">
          <button class="secondary-button" type="button" data-hide-menu>Hide menu</button>
          <button class="secondary-button" type="button" aria-pressed="false" data-fullscreen>Full screen</button>
        </div>
        <p class="wave-status" aria-live="polite" hidden></p>
        <p class="control-help">W/S throttle · A/D steer · drag to look · R rogue wave</p>
      </section>
    `;
    app.append(this.interfaceRoot);

    const intensityGroup = this.createRangeControl('Sea intensity', 'sea-intensity', 70);
    const intensityHost = this.interfaceRoot.querySelector<HTMLElement>('[data-intensity]');
    const throttleGroup = this.createRangeControl('Throttle', 'ship-throttle', 60);
    const throttleHost = this.interfaceRoot.querySelector<HTMLElement>('[data-throttle]');
    const zoomGroup = this.createRangeControl('Camera zoom', 'camera-zoom', 100, 50, 150);
    const zoomHost = this.interfaceRoot.querySelector<HTMLElement>('[data-zoom]');
    const heading = this.interfaceRoot.querySelector<HTMLElement>('[data-heading]');
    const speed = this.interfaceRoot.querySelector<HTMLElement>('[data-speed]');
    const portButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-port]');
    const starboardButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-starboard]');
    const launchButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-rogue]');
    const centerButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-center]');
    const viewButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-view-toggle]');
    const menuRevealButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-menu-reveal]');
    const hideMenuButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-hide-menu]');
    const fullscreenButton = this.interfaceRoot.querySelector<HTMLButtonElement>('[data-fullscreen]');
    const vesselSelect = this.interfaceRoot.querySelector<HTMLSelectElement>('[data-vessel]');
    const statusLine = this.interfaceRoot.querySelector<HTMLParagraphElement>('.wave-status');
    if (
      !intensityHost ||
      !throttleHost ||
      !zoomHost ||
      !heading ||
      !speed ||
      !portButton ||
      !starboardButton ||
      !launchButton ||
      !centerButton ||
      !viewButton ||
      !menuRevealButton ||
      !hideMenuButton ||
      !fullscreenButton ||
      !vesselSelect ||
      !statusLine
    ) {
      throw new Error('Unable to build sailing controls');
    }
    intensityHost.append(intensityGroup.group);
    throttleHost.append(throttleGroup.group);
    zoomHost.append(zoomGroup.group);
    this.intensityRange = intensityGroup.input;
    this.intensityOutput = intensityGroup.output;
    this.throttleRange = throttleGroup.input;
    this.throttleOutput = throttleGroup.output;
    this.zoomRange = zoomGroup.input;
    this.zoomOutput = zoomGroup.output;
    this.headingValue = heading;
    this.speedValue = speed;
    this.portButton = portButton;
    this.starboardButton = starboardButton;
    this.launchButton = launchButton;
    this.viewButton = viewButton;
    this.menuRevealButton = menuRevealButton;
    this.fullscreenButton = fullscreenButton;
    this.vesselSelect = vesselSelect;
    this.statusLine = statusLine;
    this.statusLine.hidden = true;

    const signal = this.abortController.signal;
    this.intensityRange.addEventListener(
      'input',
      () => {
        this.sea.setIntensity(Number(this.intensityRange.value));
        this.intensityOutput.value = `${this.intensityRange.value}%`;
      },
      { signal },
    );
    this.throttleRange.addEventListener(
      'input',
      () => {
        this.throttle = Number(this.throttleRange.value) / 100;
        this.throttleOutput.value = `${this.throttleRange.value}%`;
      },
      { signal },
    );
    this.launchButton.addEventListener('click', () => this.launchRogue(), { signal });
    this.zoomRange.addEventListener(
      'input',
      () => {
        this.cameraZoom = Number(this.zoomRange.value) / 100;
        this.zoomOutput.value = `${this.zoomRange.value}%`;
      },
      { signal },
    );
    centerButton.addEventListener(
      'click',
      () => {
        this.lookYaw = 0;
        this.lookPitch = 0;
      },
      { signal },
    );
    viewButton.addEventListener(
      'click',
      () => {
        this.isometricView = !this.isometricView;
        this.lookYaw = 0;
        this.lookPitch = 0;
        this.viewButton.textContent = this.isometricView ? 'Return to helm view' : 'Isometric view';
        this.viewButton.setAttribute('aria-pressed', String(this.isometricView));
      },
      { signal },
    );
    hideMenuButton.addEventListener('click', () => this.setMenuHidden(true), { signal });
    menuRevealButton.addEventListener('click', () => this.setMenuHidden(false), { signal });
    fullscreenButton.addEventListener('click', () => void this.toggleFullscreen(), { signal });
    vesselSelect.addEventListener(
      'change',
      () => this.ship.setVesselSize(this.vesselSelect.value as VesselSize),
      { signal },
    );
    this.listenForHold(this.portButton, this.portPointers);
    this.listenForHold(this.starboardButton, this.starboardPointers);

    this.canvas.addEventListener('pointerdown', this.onLookPointerDown, { signal });
    this.canvas.addEventListener('pointermove', this.onLookPointerMove, { signal });
    this.canvas.addEventListener('pointerup', this.onLookPointerEnd, { signal });
    this.canvas.addEventListener('pointercancel', this.onLookPointerEnd, { signal });
    this.canvas.addEventListener('lostpointercapture', this.onLookPointerEnd, { signal });
    document.addEventListener('keydown', this.onKeyDown, { signal });
    document.addEventListener('keyup', this.onKeyUp, { signal });
    document.addEventListener('focusin', this.onFocusIn, { signal });
    document.addEventListener('visibilitychange', this.onVisibilityChange, { signal });
    window.addEventListener('blur', this.onWindowBlur, { signal });
    document.addEventListener('fullscreenchange', this.onFullscreenChange, { signal });
    this.updateHud();
    this.updateFullscreenButton();
  }

  update(dt: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const accelerating = this.heldKeys.has('w') || this.heldKeys.has('arrowup');
    const decelerating = this.heldKeys.has('s') || this.heldKeys.has('arrowdown');
    if (accelerating !== decelerating) {
      this.throttle = Math.max(
        0,
        Math.min(1, this.throttle + (accelerating ? 1 : -1) * THROTTLE_RATE * step),
      );
    }
    this.updateRudder();
  }

  updateHud(): void {
    const degrees = (((this.ship.heading * 180) / Math.PI) % 360 + 360) % 360;
    const displayedHeading = Math.round(degrees) % 360;
    this.headingValue.textContent = `${String(displayedHeading).padStart(3, '0')}°`;
    this.speedValue.textContent = `${(this.ship.speed * 1.94384).toFixed(1)} kn`;

    const throttlePercent = Math.round(this.throttle * 100);
    if (Number(this.throttleRange.value) !== throttlePercent) {
      this.throttleRange.value = String(throttlePercent);
    }
    this.throttleOutput.value = `${throttlePercent}%`;
    this.intensityOutput.value = `${this.intensityRange.value}%`;

    const active = this.sea.activeRogues;
    this.launchButton.disabled = active === 3;
    this.statusLine.hidden = active === 0;
    this.statusLine.textContent = active === 3 ? '3 waves active' : 'Rogue wave approaching';
  }

  clearHeldInput(): void {
    for (const pointerId of this.portPointers) {
      if (this.portButton.hasPointerCapture(pointerId)) this.portButton.releasePointerCapture(pointerId);
    }
    for (const pointerId of this.starboardPointers) {
      if (this.starboardButton.hasPointerCapture(pointerId)) {
        this.starboardButton.releasePointerCapture(pointerId);
      }
    }
    if (this.lookPointerId !== null && this.canvas.hasPointerCapture(this.lookPointerId)) {
      this.canvas.releasePointerCapture(this.lookPointerId);
    }
    this.heldKeys.clear();
    this.portPointers.clear();
    this.starboardPointers.clear();
    this.lookPointerId = null;
    this.portButton.classList.remove('is-held');
    this.starboardButton.classList.remove('is-held');
    this.rudder = 0;
  }

  dispose(): void {
    this.clearHeldInput();
    this.abortController.abort();
    this.interfaceRoot.remove();
  }

  private setMenuHidden(hidden: boolean): void {
    this.interfaceRoot.classList.toggle('menu-hidden', hidden);
    this.menuRevealButton.hidden = !hidden;
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await this.canvas.parentElement?.requestFullscreen();
  }

  private updateFullscreenButton(): void {
    const active = document.fullscreenElement !== null;
    this.fullscreenButton.textContent = active ? 'Exit full screen' : 'Full screen';
    this.fullscreenButton.setAttribute('aria-pressed', String(active));
  }

  private createRangeControl(
    labelText: string,
    inputId: string,
    initialValue: number,
    min = 0,
    max = 100,
  ): RangeControl {
    const group = document.createElement('div');
    group.className = 'range-control';
    const heading = document.createElement('div');
    heading.className = 'range-heading';
    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = labelText;
    const output = document.createElement('output');
    output.htmlFor = inputId;
    output.value = `${initialValue}%`;
    heading.append(label, output);

    const input = document.createElement('input');
    input.id = inputId;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(initialValue);
    input.setAttribute('aria-label', labelText);
    group.append(heading, input);

    if (inputId === 'sea-intensity') {
      const endpoints = document.createElement('div');
      endpoints.className = 'range-endpoints';
      const calm = document.createElement('span');
      calm.textContent = 'Calm';
      const storm = document.createElement('span');
      storm.textContent = 'Storm';
      endpoints.append(calm, storm);
      group.append(endpoints);
    }
    return { group, input, output };
  }

  private listenForHold(button: HTMLButtonElement, pointers: Set<number>): void {
    const signal = this.abortController.signal;
    button.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        pointers.add(event.pointerId);
        button.setPointerCapture(event.pointerId);
        button.classList.add('is-held');
      },
      { signal },
    );
    const release = (event: PointerEvent): void => {
      pointers.delete(event.pointerId);
      if (pointers.size === 0) button.classList.remove('is-held');
    };
    button.addEventListener('pointerup', release, { signal });
    button.addEventListener('pointercancel', release, { signal });
    button.addEventListener('lostpointercapture', release, { signal });
  }

  private launchRogue(): void {
    this.sea.launchRogue(this.ship.worldX, this.ship.worldZ, this.ship.heading);
    this.updateHud();
  }

  private updateRudder(): void {
    const portActive =
      this.heldKeys.has('a') || this.heldKeys.has('arrowleft') || this.portPointers.size > 0;
    const starboardActive =
      this.heldKeys.has('d') || this.heldKeys.has('arrowright') || this.starboardPointers.size > 0;
    this.rudder = Number(starboardActive) - Number(portActive);
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof Element &&
      target.closest('input, textarea, select, button, [contenteditable="true"]') !== null;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.isInteractiveTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'r') {
      if (!event.repeat) this.launchRogue();
      event.preventDefault();
      return;
    }
    if (
      key === 'w' ||
      key === 's' ||
      key === 'a' ||
      key === 'd' ||
      key === 'arrowup' ||
      key === 'arrowdown' ||
      key === 'arrowleft' ||
      key === 'arrowright'
    ) {
      this.heldKeys.add(key);
      this.updateRudder();
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    this.heldKeys.delete(key);
    this.updateRudder();
    if (!this.isInteractiveTarget(event.target) && key.startsWith('arrow')) {
      event.preventDefault();
    }
  };

  private onFocusIn = (event: FocusEvent): void => {
    if (!this.isInteractiveTarget(event.target)) return;
    this.heldKeys.clear();
    this.updateRudder();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) this.clearHeldInput();
  };

  private onWindowBlur = (): void => {
    this.clearHeldInput();
  };

  private onFullscreenChange = (): void => {
    this.updateFullscreenButton();
  };

  private onLookPointerDown = (event: PointerEvent): void => {
    if (this.lookPointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    this.lookPointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onLookPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.lookPointerId) return;
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    if (this.isometricView) return;
    this.lookYaw = Math.max(-LOOK_YAW_LIMIT, Math.min(LOOK_YAW_LIMIT, this.lookYaw + dx * LOOK_SENSITIVITY));
    this.lookPitch = Math.max(
      -LOOK_DOWN_LIMIT,
      Math.min(LOOK_UP_LIMIT, this.lookPitch - dy * LOOK_SENSITIVITY),
    );
  };

  private onLookPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId === this.lookPointerId) this.lookPointerId = null;
  };
}
