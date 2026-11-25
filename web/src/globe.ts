import gsap from 'gsap'
import { Observer } from 'gsap/Observer'
import * as THREE from 'three'

gsap.registerPlugin(Observer)

const SCALE = 150
const INK = new THREE.Color('#171a20')
const MIST = new THREE.Color('#b9bbbe')
const RED = new THREE.Color('#e31937')
const TILT_LIMIT = 1.25

// lon 0 faces +z, so facing a place means rotating y by -lon and x by lat.
export function toVector(lat: number, lon: number, r = 1): THREE.Vector3 {
  const la = THREE.MathUtils.degToRad(lat)
  const lo = THREE.MathUtils.degToRad(lon)
  return new THREE.Vector3(
    r * Math.cos(la) * Math.sin(lo),
    r * Math.sin(la),
    r * Math.cos(la) * Math.cos(lo),
  )
}

export function toLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  const n = v.clone().normalize()
  return {
    lat: THREE.MathUtils.radToDeg(Math.asin(n.y)),
    lon: THREE.MathUtils.radToDeg(Math.atan2(n.x, n.z)),
  }
}

const vertex = /* glsl */ `
  attribute float aSeed;
  uniform float uSize;
  uniform float uPixel;
  uniform float uReveal;
  uniform vec3 uHover;
  uniform float uHoverAmt;
  uniform vec3 uPick;
  uniform float uPickAmt;
  uniform float uPulse;
  varying float vFacing;
  varying float vSeed;
  varying float vHover;
  varying float vRing;
  varying float vCore;

  void main() {
    vec3 n = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 viewNormal = normalize(normalMatrix * n);
    vFacing = dot(viewNormal, normalize(-mv.xyz));
    vSeed = aSeed;

    float h = 1.0 - smoothstep(0.0, 0.2, distance(n, uHover));
    h = h * h;
    vHover = h * uHoverAmt;

    float d = distance(n, uPick);
    vCore = (1.0 - smoothstep(0.0, 0.018, d)) * uPickAmt;
    float ring = 1.0 - smoothstep(0.0, 0.012, abs(d - uPulse * 0.16));
    vRing = ring * (1.0 - uPulse) * uPickAmt;

    // Dots rise from the surface as they are revealed: a short, soft landing.
    float shown = smoothstep(aSeed, aSeed + 0.18, uReveal);
    // Under the pointer the surface swells a touch instead of darkening.
    vec3 lifted = position * (1.0 + (1.0 - shown) * 0.08 + vHover * 0.035);
    mv = modelViewMatrix * vec4(lifted, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = uSize * (0.7 + aSeed * 0.6) * (1.0 + vHover * 0.15 + vRing * 1.2 + vCore * 1.6);
    gl_PointSize = size * uPixel * shown / -mv.z;
  }
`

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uRed;
  uniform float uAlpha;
  uniform float uBack;
  uniform float uFade;
  varying float vFacing;
  varying float vSeed;
  varying float vHover;
  varying float vRing;
  varying float vCore;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    if (r > 0.5) discard;
    float edge = 1.0 - smoothstep(0.38, 0.5, r);
    float front = smoothstep(-0.15, 0.55, vFacing);
    float a = mix(uBack, uAlpha, front) * edge;
    a *= 0.75 + vSeed * 0.25;
    float red = max(vRing, vCore) * step(0.0, vFacing);
    vec3 col = mix(uColor, uRed, red);
    a = max(a, red * edge);
    gl_FragColor = vec4(col, a * uFade);
  }
`

function material(color: THREE.Color, size: number, alpha: number, back: number) {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: color },
      uRed: { value: RED },
      uSize: { value: size },
      uPixel: { value: 1 },
      uAlpha: { value: alpha },
      uBack: { value: back },
      uFade: { value: 1 },
      uReveal: { value: 0 },
      uHover: { value: new THREE.Vector3(0, 0, 9) },
      uHoverAmt: { value: 0 },
      uPick: { value: new THREE.Vector3(0, 0, 9) },
      uPickAmt: { value: 0 },
      uPulse: { value: 0 },
    },
  })
}

function fibonacci(n: number): Float32Array {
  const out = new Float32Array(n * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const t = golden * i
    out.set([Math.cos(t) * r, y, Math.sin(t) * r], i * 3)
  }
  return out
}

function seeds(n: number, bias?: Float32Array): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // Reveal sweeps from east to west with a little grain, like a scan.
    const sweep = bias
      ? (Math.atan2(bias[i * 3], bias[i * 3 + 2]) / Math.PI + 1) / 2
      : Math.random()
    out[i] = Math.min(0.82, sweep * 0.6 + Math.random() * 0.22)
  }
  return out
}

export interface Pick {
  lat: number
  lon: number
}

export class Globe {
  readonly group = new THREE.Group()
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50)
  private land!: THREE.ShaderMaterial
  private sea!: THREE.ShaderMaterial
  private materials: THREE.ShaderMaterial[] = []
  private sphere = new THREE.Sphere(new THREE.Vector3(), 1)
  private ray = new THREE.Raycaster()
  private pointer = new THREE.Vector2(9, 9)
  // Camera distance at rest; set from the viewport so the globe fits a phone too.
  private rest = 7.4
  private state = { rx: 0.42, ry: -0.3, z: 7.4, spin: 1, shift: 0, lift: 0.012 }
  private pulse: gsap.core.Tween | null = null
  private observer: Observer | null = null
  private idleAt = 0
  private locked = false
  onPick: (p: Pick) => void = () => {}

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setClearColor(0xffffff, 0)
    this.scene.add(this.group)
  }

  async load(url: string): Promise<void> {
    const raw = new Int16Array(await (await fetch(url)).arrayBuffer())
    const count = raw.length / 2
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const v = toVector(raw[i * 2] / SCALE, raw[i * 2 + 1] / SCALE)
      pos.set([v.x, v.y, v.z], i * 3)
    }
    const landGeo = new THREE.BufferGeometry()
    landGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    landGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds(count, pos), 1))
    this.land = material(INK, 0.0058, 0.9, 0.06)

    // A sparse veil over the whole sphere so the oceans still read as a globe.
    const seaPos = fibonacci(36_000)
    const seaGeo = new THREE.BufferGeometry()
    seaGeo.setAttribute('position', new THREE.BufferAttribute(seaPos, 3))
    seaGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds(36_000, seaPos), 1))
    this.sea = material(MIST, 0.005, 0.5, 0.0)

    this.materials = [this.sea, this.land]
    this.group.add(new THREE.Points(seaGeo, this.sea), new THREE.Points(landGeo, this.land))
    this.resize()
    this.bind()
    gsap.ticker.add(this.frame)
  }

  intro(): gsap.core.Timeline {
    const tl = gsap.timeline()
    tl.fromTo(
      this.state,
      { z: this.rest + 1.6 },
      { z: this.rest, duration: 2.6, ease: 'expo.out' },
      0,
    )
    for (const m of this.materials) {
      tl.to(m.uniforms.uReveal, { value: 1, duration: 2.8, ease: 'power2.inOut' }, 0)
    }
    tl.fromTo(this.state, { ry: -1.4 }, { ry: -0.3, duration: 3.2, ease: 'expo.out' }, 0)
    return tl
  }

  private bind() {
    let moved = 0
    this.observer = Observer.create({
      target: this.canvas,
      type: 'pointer,touch,wheel',
      dragMinimum: 2,
      onPress: () => {
        moved = 0
        gsap.killTweensOf(this.state, 'rx,ry')
        this.state.spin = 0
      },
      onDrag: (self) => {
        if (this.locked) return
        moved += Math.abs(self.deltaX) + Math.abs(self.deltaY)
        const k = 0.0042 * (this.state.z / this.rest)
        this.state.ry += self.deltaX * k
        this.state.rx = gsap.utils.clamp(-TILT_LIMIT, TILT_LIMIT, this.state.rx + self.deltaY * k)
      },
      onDragEnd: (self) => {
        if (this.locked) return
        // Let the globe carry on a little, the way a real one would.
        const k = 0.00034 * (this.state.z / this.rest)
        gsap.to(this.state, {
          ry: this.state.ry + self.velocityX * k,
          rx: gsap.utils.clamp(-TILT_LIMIT, TILT_LIMIT, this.state.rx + self.velocityY * k),
          duration: 1.6,
          ease: 'power3.out',
        })
        this.idleAt = performance.now()
      },
      onRelease: (self) => {
        if (this.locked || moved > 6) return
        const hit = this.hit(self.event as PointerEvent)
        if (hit) this.onPick(hit)
      },
      onWheel: (self) => {
        if (this.locked) return
        gsap.to(this.state, {
          z: gsap.utils.clamp(2.6, this.rest * 1.35, this.state.z + self.deltaY * 0.003),
          duration: 0.8,
          ease: 'power3.out',
          overwrite: 'auto',
        })
      },
      preventDefault: true,
    })

    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect()
      this.pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      )
    })
    this.canvas.addEventListener('pointerleave', () => this.pointer.set(9, 9))
    window.addEventListener('resize', () => this.resize())
  }

  private local(ndc: THREE.Vector2): THREE.Vector3 | null {
    this.ray.setFromCamera(ndc, this.camera)
    const p = this.ray.ray.intersectSphere(this.sphere, new THREE.Vector3())
    if (!p) return null
    return this.group.worldToLocal(p)
  }

  private hit(e: PointerEvent): Pick | null {
    const r = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    )
    const p = this.local(ndc)
    return p ? toLatLon(p) : null
  }

  setPick(p: Pick | null) {
    this.pulse?.kill()
    for (const m of this.materials) {
      if (p) m.uniforms.uPick.value.copy(toVector(p.lat, p.lon))
      gsap.to(m.uniforms.uPickAmt, { value: p ? 1 : 0, duration: 0.5 })
    }
    if (!p) return
    const pulses = this.materials.map((m) => m.uniforms.uPulse)
    this.pulse = gsap.fromTo(
      pulses,
      { value: 0 },
      { value: 1, duration: 2.2, ease: 'power1.out', repeat: -1 },
    )
  }

  // Turns the globe so a place faces the viewer.
  face(p: Pick, duration = 1.6, z = this.state.z): gsap.core.Tween {
    const target = -THREE.MathUtils.degToRad(p.lon)
    // Take the short way round.
    const ry =
      this.state.ry +
      ((((target - this.state.ry) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) -
      Math.PI
    this.state.spin = 0
    return gsap.to(this.state, {
      rx: THREE.MathUtils.degToRad(p.lat),
      ry,
      z,
      duration,
      ease: 'expo.inOut',
      overwrite: 'auto',
    })
  }

  dive(p: Pick): gsap.core.Timeline {
    this.locked = true
    const tl = gsap.timeline()
    tl.to(this.state, { lift: 0, duration: 1.5, ease: 'expo.inOut' }, 0)
    tl.add(this.face(p, 1.5, 3.4), 0)
    tl.to(this.state, { z: 1.6, duration: 1.1, ease: 'power3.in' })
    tl.to(
      this.materials.map((m) => m.uniforms.uFade),
      { value: 0, duration: 0.8, ease: 'power1.in' },
      '-=0.9',
    )
    return tl
  }

  rise(): gsap.core.Timeline {
    const tl = gsap.timeline({
      onComplete: () => {
        this.locked = false
        this.idleAt = performance.now()
      },
    })
    tl.to(
      this.materials.map((m) => m.uniforms.uFade),
      { value: 1, duration: 0.8 },
      0,
    )
    tl.to(this.state, { z: this.rest, lift: 0.012, duration: 1.8, ease: 'expo.out' }, 0)
    return tl
  }

  // Slides the globe sideways while a panel is open next to it.
  shift(x: number) {
    gsap.to(this.state, { shift: x, duration: 1.2, ease: 'expo.inOut' })
  }

  // Where a place sits on screen, for the HTML marker that follows it.
  project(p: Pick): { x: number; y: number; visible: boolean } {
    const v = toVector(p.lat, p.lon)
    const world = this.group.localToWorld(v.clone())
    const facing = world
      .clone()
      .normalize()
      .dot(this.camera.position.clone().sub(world).normalize())
    const s = world.project(this.camera)
    const r = this.canvas.getBoundingClientRect()
    return {
      x: r.left + ((s.x + 1) / 2) * r.width,
      y: r.top + ((1 - s.y) / 2) * r.height,
      visible: facing > 0.08,
    }
  }

  private resize() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    const dpr = Math.min(window.devicePixelRatio, 2)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    const radius = Math.min(h * 0.235, w * 0.42)
    const rest = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * radius)
    if (!this.locked && Math.abs(this.state.z - this.rest) < 0.01) this.state.z = rest
    this.rest = rest
    // Point sizes are in world units; convert to pixels for this viewport.
    const px = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))
    for (const m of this.materials) m.uniforms.uPixel.value = px
  }

  private frame = (_t: number, dt: number) => {
    if (!this.locked && this.state.spin < 1 && performance.now() - this.idleAt > 3500) {
      this.state.spin = Math.min(1, this.state.spin + dt / 2500)
    }
    if (!this.locked) this.state.ry += 0.00011 * dt * this.state.spin
    this.group.rotation.set(this.state.rx, this.state.ry, 0, 'XYZ')
    this.camera.position.set(0, 0, this.state.z)
    this.camera.setViewOffset(
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      -this.state.shift * this.canvas.clientWidth,
      -this.state.lift * this.canvas.clientHeight,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    )

    const hover = this.locked ? null : this.local(this.pointer)
    for (const m of this.materials) {
      if (hover) m.uniforms.uHover.value.copy(hover.normalize())
      m.uniforms.uHoverAmt.value += ((hover ? 1 : 0) - m.uniforms.uHoverAmt.value) * 0.08
    }
    this.canvas.style.cursor = hover ? 'pointer' : ''
    this.renderer.render(this.scene, this.camera)
  }

  destroy() {
    gsap.ticker.remove(this.frame)
    this.observer?.kill()
    this.renderer.dispose()
  }
}
