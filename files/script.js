/**
 * DEADZONE — FPS Survival Shooter
 * script.js
 *
 * Architecture:
 *  - GameState       : centralised state machine
 *  - AudioManager    : procedurally generated sounds (Web Audio API)
 *  - World           : Three.js scene, lighting, environment
 *  - Player          : FPS camera, movement, health, ammo
 *  - GunSystem       : shooting, recoil, reload, muzzle flash
 *  - EnemyManager    : spawning, AI, health, death
 *  - PickupManager   : health & ammo pickups
 *  - ParticleSystem  : bullet impacts, blood, sparks
 *  - InputManager    : keyboard, mouse, touch
 *  - HUD             : updates all DOM elements
 */

'use strict';

/* ═══════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════ */
const GRAVITY       = -22;
const PLAYER_SPEED  = 9;
const JUMP_FORCE    = 9;
const PLAYER_HEIGHT = 1.7;
const GROUND_Y      = 0;
const MAX_HP        = 100;
const RELOAD_TIME   = 2000;   // ms
const MAX_AMMO      = 30;
const RESERVE_AMMO  = 120;

// Enemy types: { name, color, hp, speed, damage, size, score }
const ENEMY_TYPES = [
  { name:'Grunt',    color:0xff3300, hp:60,  speed:3.5, damage:8,  size:0.55, score:100 },
  { name:'Brute',    color:0x881111, hp:150, speed:2.0, damage:15, size:0.75, score:250 },
  { name:'Sprinter', color:0xff8800, hp:35,  speed:6.5, damage:6,  size:0.45, score:150 },
  { name:'Tank',     color:0x440000, hp:300, speed:1.4, damage:25, size:1.0,  score:500 },
];

/* ═══════════════════════════════════════════════════════
   AUDIO MANAGER  (all sounds generated procedurally)
   — no external files needed
═══════════════════════════════════════════════════════ */
const AudioManager = (() => {
  let ctx = null;
  let masterGain = null;
  let bgNode = null;
  let bgGain = null;

  function init() {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(ctx.destination);
    } catch(e) { console.warn('Web Audio unavailable'); }
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /** Generic helper — create an oscillator burst */
  function playTone(freq, type, duration, gainVal, detune=0) {
    if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.detune.value = detune;
    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }

  /** White-noise burst via AudioBuffer */
  function playNoise(duration, gainVal, hipass=0) {
    if (!ctx) return;
    const bufLen = Math.ceil(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1);
    const src  = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    if (hipass > 0) {
      const filt = ctx.createBiquadFilter();
      filt.type = 'highpass';
      filt.frequency.value = hipass;
      src.connect(filt);
      filt.connect(gain);
    } else {
      src.connect(gain);
    }
    gain.connect(masterGain);
    src.start();
    src.stop(ctx.currentTime + duration);
  }

  const sounds = {
    gunshot() {
      // Layered: noise crack + low boom
      playNoise(0.12, 0.9, 3000);
      playNoise(0.25, 0.6, 500);
      playTone(80,  'sine',   0.3, 0.5);
      playTone(120, 'square', 0.08, 0.3);
    },
    empty() {
      playTone(800, 'square', 0.07, 0.15);
      playTone(400, 'square', 0.05, 0.1);
    },
    reload() {
      // metallic click sequence
      setTimeout(() => playNoise(0.06, 0.35, 4000), 0);
      setTimeout(() => playNoise(0.08, 0.4,  3000), 300);
      setTimeout(() => { playNoise(0.05, 0.5, 5000); playTone(200,'square',0.04,0.2); }, 1800);
    },
    hit() {
      playNoise(0.08, 0.45, 1000);
      playTone(180, 'sine', 0.12, 0.3);
    },
    playerHurt() {
      playTone(250, 'sawtooth', 0.18, 0.4);
      playNoise(0.12, 0.35, 800);
    },
    enemyDeath() {
      playTone(120, 'sawtooth', 0.25, 0.35);
      playNoise(0.18, 0.3, 600);
    },
    enemyGroan() {
      playTone(90 + Math.random()*40, 'sine', 0.3, 0.18);
    },
    pickup() {
      playTone(600, 'sine', 0.12, 0.3);
      playTone(900, 'sine', 0.10, 0.25);
    },
    jump() {
      playTone(180, 'sine', 0.12, 0.15);
    },
    waveStart() {
      [300,400,500,600].forEach((f,i) =>
        setTimeout(() => playTone(f,'square',0.2,0.2), i*120));
    }
  };

  /** Pulsing ominous background drone */
  function startBGM() {
    if (!ctx) return;
    stopBGM();
    bgGain = ctx.createGain();
    bgGain.gain.value = 0.06;
    bgGain.connect(masterGain);

    function addDrone(freq, detune) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.3;
      lfoGain.gain.value = 8;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      osc.connect(bgGain);
      lfo.start();
      osc.start();
      return osc;
    }

    bgNode = [
      addDrone(55, 0),
      addDrone(55, 7),
      addDrone(110, -5),
    ];
  }

  function stopBGM() {
    if (bgNode) { bgNode.forEach(n => { try { n.stop(); } catch(e){} }); bgNode = null; }
    if (bgGain) { bgGain.disconnect(); bgGain = null; }
  }

  return { init, resume, sounds, startBGM, stopBGM };
})();

/* ═══════════════════════════════════════════════════════
   INPUT MANAGER
═══════════════════════════════════════════════════════ */
const InputManager = (() => {
  const keys = {};
  const mouse = { dx: 0, dy: 0, locked: false, fireDown: false };
  // Touch joystick state
  const joy   = { active: false, id: null, startX: 0, startY: 0, dx: 0, dy: 0 };

  function init() {
    document.addEventListener('keydown', e => {
      keys[e.code] = true;
      if (e.code === 'Escape') GameState.togglePause();
    });
    document.addEventListener('keyup',   e => keys[e.code] = false);

    document.addEventListener('mousemove', e => {
      if (mouse.locked) {
        mouse.dx += e.movementX || 0;
        mouse.dy += e.movementY || 0;
      }
    });
    document.addEventListener('mousedown', e => {
      if (e.button === 0 && mouse.locked) mouse.fireDown = true;
    });
    document.addEventListener('mouseup',   e => {
      if (e.button === 0) mouse.fireDown = false;
    });
    document.addEventListener('pointerlockchange', () => {
      mouse.locked = document.pointerLockElement === renderer.domElement;
    });
  }

  function consumeMouse() {
    const r = { dx: mouse.dx, dy: mouse.dy };
    mouse.dx = 0; mouse.dy = 0;
    return r;
  }

  return { keys, mouse, joy, init, consumeMouse };
})();

/* ═══════════════════════════════════════════════════════
   THREE.JS GLOBALS
═══════════════════════════════════════════════════════ */
let renderer, scene, camera, clock;

/* ═══════════════════════════════════════════════════════
   GAME STATE
═══════════════════════════════════════════════════════ */
const GameState = (() => {
  let state = 'menu'; // menu | playing | paused | gameover
  let wave = 1, kills = 0, shots = 0, hits = 0;

  function setState(s) { state = s; }
  function getState()  { return state; }

  function startGame() {
    wave = 1; kills = 0; shots = 0; hits = 0;
    setState('playing');
    document.getElementById('start-menu').style.display = 'none';
    document.getElementById('game-over').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    AudioManager.startBGM();
    Player.reset();
    EnemyManager.reset();
    PickupManager.reset();
    WaveSystem.reset();
    HUD.update();
    renderer.domElement.requestPointerLock();
  }

  function gameOver() {
    setState('gameover');
    document.exitPointerLock();
    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('go-wave').textContent  = wave;
    document.getElementById('go-kills').textContent = kills;
    const acc = shots > 0 ? Math.round((hits/shots)*100) : 0;
    document.getElementById('go-acc').textContent = acc + '%';
    AudioManager.stopBGM();
  }

  function togglePause() {
    if (state === 'playing') {
      setState('paused');
      document.exitPointerLock();
      document.getElementById('pause-menu').classList.remove('hidden');
    } else if (state === 'paused') {
      setState('playing');
      document.getElementById('pause-menu').classList.add('hidden');
      renderer.domElement.requestPointerLock();
    }
  }

  function addKill() { kills++; }
  function addShot() { shots++; }
  function addHit()  { hits++;  }
  function nextWave(){ wave++;  }
  function getWave() { return wave; }
  function getKills(){ return kills; }

  return { getState, setState, startGame, gameOver, togglePause, addKill, addShot, addHit, nextWave, getWave, getKills };
})();

/* ═══════════════════════════════════════════════════════
   PARTICLE SYSTEM
═══════════════════════════════════════════════════════ */
const ParticleSystem = (() => {
  const particles = [];

  function spawnImpact(pos, normal, color=0xffaa00, count=12) {
    for (let i = 0; i < count; i++) {
      const geo  = new THREE.SphereGeometry(0.03 + Math.random()*0.04, 4, 4);
      const mat  = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      const speed = 2 + Math.random() * 5;
      const dir   = new THREE.Vector3(
        normal.x + (Math.random()-0.5)*1.5,
        normal.y + (Math.random()-0.5)*1.5 + 1,
        normal.z + (Math.random()-0.5)*1.5
      ).normalize();
      particles.push({
        mesh, vel: dir.multiplyScalar(speed),
        life: 0.3 + Math.random()*0.4, age: 0, type:'dot'
      });
      scene.add(mesh);
    }
  }

  function spawnBlood(pos, count=16) {
    spawnImpact(pos, new THREE.Vector3(0,1,0), 0xcc1111, count);
  }

  function spawnMuzzleFlash(pos) {
    const geo  = new THREE.SphereGeometry(0.12, 6, 6);
    const mat  = new THREE.MeshBasicMaterial({ color:0xffee88 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    particles.push({ mesh, vel: new THREE.Vector3(), life: 0.06, age: 0, type:'flash' });
    scene.add(mesh);
  }

  function update(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        particles.splice(i, 1);
        continue;
      }
      const t = p.age / p.life;
      if (p.type === 'dot') {
        p.vel.y += GRAVITY * 0.3 * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.material.opacity = 1 - t;
        p.mesh.material.transparent = true;
      } else if (p.type === 'flash') {
        const s = 1 - t;
        p.mesh.scale.setScalar(s);
        p.mesh.material.opacity = s;
        p.mesh.material.transparent = true;
      }
    }
  }

  function reset() {
    particles.forEach(p => { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
    particles.length = 0;
  }

  return { spawnImpact, spawnBlood, spawnMuzzleFlash, update, reset };
})();

/* ═══════════════════════════════════════════════════════
   WORLD — environment, buildings, ground
═══════════════════════════════════════════════════════ */
const World = (() => {
  const collidables = []; // Array<{mesh, box:THREE.Box3}>

  function buildCheckerTexture(size=512, squares=16) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const sq = size / squares;
    for (let r=0;r<squares;r++) for (let c=0;c<squares;c++) {
      ctx.fillStyle = (r+c)%2===0 ? '#1a1a1a' : '#111111';
      ctx.fillRect(c*sq, r*sq, sq, sq);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8,8);
    return tex;
  }

  function buildWallTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0,0,256,256);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    for (let y=0;y<256;y+=32) {
      const ox = (Math.floor(y/32)%2===0) ? 0 : 48;
      for (let x=-48+ox;x<256;x+=96) {
        ctx.strokeRect(x+2, y+2, 92, 28);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2,2);
    return tex;
  }

  function addBuilding(x, z, w, d, h) {
    const geo  = new THREE.BoxGeometry(w, h, d);
    const mat  = new THREE.MeshLambertMaterial({ map: buildWallTexture(), color:0x888888 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, h/2, z);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    collidables.push({ mesh, box });

    // Windows
    const winMat = new THREE.MeshBasicMaterial({ color:0x334455 });
    const cols = Math.floor(w/3);
    const rows = Math.floor(h/4);
    for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) {
      const wg = new THREE.PlaneGeometry(1.2, 1.8);
      const wm = new THREE.Mesh(wg, winMat);
      const wx = x - w/2 + 1.5 + c*3 + 0.3;
      const wy = 2 + r*4;
      wm.position.set(wx, wy, z + d/2 + 0.01);
      scene.add(wm);
    }
    return mesh;
  }

  function init() {
    // Ground
    const groundGeo = new THREE.PlaneGeometry(200, 200, 40, 40);
    const groundMat = new THREE.MeshLambertMaterial({ map: buildCheckerTexture() });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Arena boundary walls (invisible collidables)
    function addBoundary(x,z,w,d) {
      const g = new THREE.BoxGeometry(w,10,d);
      const m = new THREE.MeshLambertMaterial({ color:0x333333 });
      const mesh = new THREE.Mesh(g,m);
      mesh.position.set(x,5,z);
      mesh.receiveShadow = true;
      scene.add(mesh);
      collidables.push({ mesh, box: new THREE.Box3().setFromObject(mesh) });
    }
    addBoundary(  0,  95, 200,  2);
    addBoundary(  0, -95, 200,  2);
    addBoundary( 95,   0,   2, 190);
    addBoundary(-95,   0,   2, 190);

    // Buildings
    const buildingDefs = [
      [-30,  30,  12, 10, 18],
      [ 30,  30,  10, 12, 22],
      [-30, -30,  14,  8, 15],
      [ 30, -30,   8, 14, 25],
      [-60,   0,   8, 10, 20],
      [ 60,   0,  10,  8, 16],
      [  0,  60,  12, 12, 30],
      [  0, -60,  10, 10, 18],
      [-50,  50,   8,  8, 12],
      [ 50, -50,   8,  8, 14],
      [-50, -50,  10,  6, 20],
      [ 50,  50,   6, 10, 22],
      [ 20,  70,   6,  6, 10],
      [-20, -70,   6,  6, 12],
      [ 70,  20,   6,  8, 16],
      [-70, -20,   8,  6, 18],
    ];
    buildingDefs.forEach(([x,z,w,d,h]) => addBuilding(x,z,w,d,h));

    // Street lamps
    for (let angle=0; angle<Math.PI*2; angle+=Math.PI/4) {
      const r = 30;
      const x = Math.cos(angle)*r, z = Math.sin(angle)*r;
      const poleG = new THREE.CylinderGeometry(0.1, 0.1, 6, 6);
      const poleMat = new THREE.MeshLambertMaterial({ color:0x444444 });
      const pole = new THREE.Mesh(poleG, poleMat);
      pole.position.set(x, 3, z);
      scene.add(pole);
      const lampLight = new THREE.PointLight(0xffe0a0, 0.8, 20);
      lampLight.position.set(x, 6.5, z);
      scene.add(lampLight);
      const bulbG = new THREE.SphereGeometry(0.2, 8, 8);
      const bulbMat = new THREE.MeshBasicMaterial({ color:0xffeeaa });
      const bulb = new THREE.Mesh(bulbG, bulbMat);
      bulb.position.copy(lampLight.position);
      scene.add(bulb);
    }

    // Ambient debris / boxes
    const boxDefs = [
      [0,0,0.5],[5,5,0.4],[-5,5,0.6],[5,-5,0.4],[-5,-5,0.5],
      [10,2,0.4],[2,10,0.5],[-10,-2,0.4],[-2,-10,0.6]
    ];
    boxDefs.forEach(([bx,bz,bs]) => {
      const g = new THREE.BoxGeometry(1,1,1);
      const m = new THREE.MeshLambertMaterial({ color:0x553300 });
      const mesh = new THREE.Mesh(g,m);
      mesh.scale.setScalar(bs*2);
      mesh.position.set(bx,bs,bz);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      collidables.push({ mesh, box: new THREE.Box3().setFromObject(mesh) });
    });
  }

  function getCollidables() { return collidables; }

  /** Simple AABB player vs world collision */
  function resolvePlayerCollision(pos, radius=0.5) {
    collidables.forEach(({ box }) => {
      const expanded = box.clone().expandByScalar(radius);
      if (expanded.containsPoint(pos)) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const diff = pos.clone().sub(center);
        diff.y = 0;
        const size = new THREE.Vector3();
        box.getSize(size);
        const push = radius + Math.max(size.x, size.z) * 0.5;
        if (diff.length() < push) {
          diff.normalize().multiplyScalar(push - diff.length() + 0.01);
          pos.x += diff.x;
          pos.z += diff.z;
        }
      }
    });
  }

  return { init, getCollidables, resolvePlayerCollision };
})();

/* ═══════════════════════════════════════════════════════
   PLAYER
═══════════════════════════════════════════════════════ */
const Player = (() => {
  let hp = MAX_HP;
  let vel = new THREE.Vector3();
  let onGround = true;
  let yaw = 0, pitch = 0;
  const SENSITIVITY = 0.0018;
  const bobClock = { t: 0 };

  function reset() {
    hp = MAX_HP;
    vel.set(0,0,0);
    onGround = true;
    yaw = 0; pitch = 0;
    camera.position.set(0, PLAYER_HEIGHT, 0);
    camera.rotation.set(0,0,0);
    bobClock.t = 0;
    GunSystem.reset();
    HUD.setHealth(hp);
  }

  function takeDamage(amt) {
    if (GameState.getState() !== 'playing') return;
    hp = Math.max(0, hp - amt);
    HUD.setHealth(hp);
    HUD.showDamageVignette();
    AudioManager.sounds.playerHurt();
    if (hp <= 0) GameState.gameOver();
  }

  function heal(amt) {
    hp = Math.min(MAX_HP, hp + amt);
    HUD.setHealth(hp);
  }

  function getPosition() { return camera.position; }
  function getHP()       { return hp; }

  function update(dt) {
    if (GameState.getState() !== 'playing') return;

    // Mouse look
    const { dx, dy } = InputManager.consumeMouse();
    yaw   -= dx * SENSITIVITY;
    pitch -= dy * SENSITIVITY;
    pitch  = Math.max(-Math.PI/2.1, Math.min(Math.PI/2.1, pitch));

    // Apply mobile look delta if any
    if (InputManager.joy.lookDx) {
      yaw   -= InputManager.joy.lookDx * 0.003;
      pitch -= InputManager.joy.lookDy * 0.003;
      InputManager.joy.lookDx = 0;
      InputManager.joy.lookDy = 0;
    }

    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    // Movement
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right   = new THREE.Vector3( Math.cos(yaw), 0, -Math.sin(yaw));
    const move    = new THREE.Vector3();

    const jdx = InputManager.joy.dx || 0;
    const jdy = InputManager.joy.dy || 0;

    if (InputManager.keys['KeyW'] || jdy < -0.2) move.addScaledVector(forward,  PLAYER_SPEED);
    if (InputManager.keys['KeyS'] || jdy >  0.2) move.addScaledVector(forward, -PLAYER_SPEED * 0.7);
    if (InputManager.keys['KeyA'] || jdx < -0.2) move.addScaledVector(right,   -PLAYER_SPEED * 0.8);
    if (InputManager.keys['KeyD'] || jdx >  0.2) move.addScaledVector(right,    PLAYER_SPEED * 0.8);

    // Joystick analog magnitude
    if (jdx !== 0 || jdy !== 0) {
      const mag = Math.min(1, Math.sqrt(jdx*jdx + jdy*jdy));
      move.multiplyScalar(mag);
    }

    vel.x = move.x;
    vel.z = move.z;

    // Jump
    if ((InputManager.keys['Space']) && onGround) {
      vel.y = JUMP_FORCE;
      onGround = false;
      AudioManager.sounds.jump();
    }

    // Gravity
    vel.y += GRAVITY * dt;
    camera.position.addScaledVector(vel, dt);

    // Ground clamp
    if (camera.position.y <= PLAYER_HEIGHT) {
      camera.position.y = PLAYER_HEIGHT;
      vel.y = 0;
      onGround = true;
    }

    // World collision
    World.resolvePlayerCollision(camera.position);

    // Camera bob
    const moving = move.length() > 0.1 && onGround;
    if (moving) {
      bobClock.t += dt * 7;
      const bobY = Math.sin(bobClock.t) * 0.045;
      const bobX = Math.cos(bobClock.t * 0.5) * 0.02;
      GunSystem.applyBob(bobX, bobY);
    } else {
      bobClock.t = 0;
      GunSystem.applyBob(0, 0);
    }
  }

  function addAmmo(amt) {
    // GunSystem manages ammo; we call it directly
    GunSystem.addReserve(amt);
  }

  return { reset, takeDamage, heal, addAmmo, getPosition, getHP, update };
})();

/* ═══════════════════════════════════════════════════════
   GUN SYSTEM
═══════════════════════════════════════════════════════ */
const GunSystem = (() => {
  let ammo    = MAX_AMMO;
  let reserve = RESERVE_AMMO;
  let reloading   = false;
  let reloadStart = 0;
  let recoilPitch = 0;
  let recoilYaw   = 0;
  let canFire = true;
  const FIRE_RATE = 0.1; // seconds between shots
  let fireTimer = 0;

  // Gun mesh (attached to camera)
  let gunPivot, gunMesh, barrelTip;

  function buildGun() {
    gunPivot = new THREE.Object3D();
    camera.add(gunPivot);
    gunPivot.position.set(0.28, -0.22, -0.55);

    // Body
    const bodyG = new THREE.BoxGeometry(0.08, 0.12, 0.35);
    const bodyM = new THREE.MeshLambertMaterial({ color:0x222222 });
    gunMesh = new THREE.Mesh(bodyG, bodyM);
    gunPivot.add(gunMesh);

    // Barrel
    const barrelG = new THREE.CylinderGeometry(0.02, 0.025, 0.28, 8);
    const barrelM = new THREE.MeshLambertMaterial({ color:0x111111 });
    const barrel = new THREE.Mesh(barrelG, barrelM);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, -0.3);
    gunPivot.add(barrel);

    // Grip
    const gripG = new THREE.BoxGeometry(0.06, 0.15, 0.08);
    const gripM = new THREE.MeshLambertMaterial({ color:0x1a1a1a });
    const grip = new THREE.Mesh(gripG, gripM);
    grip.position.set(0, -0.12, 0.05);
    grip.rotation.x = 0.2;
    gunPivot.add(grip);

    // Barrel tip reference
    barrelTip = new THREE.Object3D();
    barrelTip.position.set(0, 0.01, -0.46);
    gunPivot.add(barrelTip);
  }

  function getBarrelWorldPos() {
    const pos = new THREE.Vector3();
    barrelTip.getWorldPosition(pos);
    return pos;
  }

  function reset() {
    ammo = MAX_AMMO; reserve = RESERVE_AMMO;
    reloading = false; canFire = true; fireTimer = 0;
    recoilPitch = 0; recoilYaw = 0;
    if (gunPivot) gunPivot.position.set(0.28, -0.22, -0.55);
    HUD.setAmmo(ammo, reserve);
  }

  function startReload() {
    if (reloading || ammo === MAX_AMMO || reserve === 0) return;
    reloading = true;
    reloadStart = performance.now();
    HUD.showReloadBar(true);
    AudioManager.sounds.reload();
  }

  function shoot() {
    if (reloading || !canFire || fireTimer > 0) return;
    if (ammo <= 0) {
      AudioManager.sounds.empty();
      startReload();
      return;
    }

    ammo--;
    GameState.addShot();
    HUD.setAmmo(ammo, reserve);
    AudioManager.sounds.gunshot();

    // Muzzle flash
    const muzzlePos = getBarrelWorldPos();
    ParticleSystem.spawnMuzzleFlash(muzzlePos);

    // Recoil
    recoilPitch -= 0.012;
    recoilYaw   += (Math.random() - 0.5) * 0.006;

    // Crosshair kick
    HUD.flashCrosshair();

    // Raycasting for hit detection
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0,0), camera);
    ray.far = 200;

    const enemyHits = ray.intersectObjects(
      EnemyManager.getAll().map(e => e.mesh), true
    );
    if (enemyHits.length > 0) {
      const closest = enemyHits[0];
      // Walk up to find which enemy
      let obj = closest.object;
      while (obj.parent && !obj.userData.enemyId) obj = obj.parent;
      const enemy = EnemyManager.getById(obj.userData.enemyId);
      if (enemy) {
        const dmg = 25 + Math.random() * 15;
        EnemyManager.damageEnemy(enemy.id, dmg, closest.point);
        GameState.addHit();
        HUD.showHitMarker();
      }
    } else {
      // Check environment
      const envObjects = World.getCollidables().map(c => c.mesh);
      const envHits = ray.intersectObjects(envObjects, true);
      if (envHits.length > 0) {
        const hp = envHits[0].point;
        const n  = envHits[0].face.normal.clone().applyQuaternion(envHits[0].object.quaternion);
        ParticleSystem.spawnImpact(hp, n, 0xccaa77, 8);
      }
    }

    fireTimer = FIRE_RATE;
    if (ammo === 0 && reserve > 0) setTimeout(() => startReload(), 300);
  }

  function applyBob(bx, by) {
    if (!gunPivot || reloading) return;
    gunPivot.position.x = 0.28 + bx;
    gunPivot.position.y = -0.22 + by;
  }

  function update(dt) {
    if (fireTimer > 0) fireTimer -= dt;

    // Recoil recovery (lerp back toward zero — "lerp" = linear interpolation)
    recoilPitch += (-recoilPitch) * Math.min(1, dt * 8);
    recoilYaw   += (-recoilYaw)   * Math.min(1, dt * 8);
    if (gunPivot) {
      gunPivot.rotation.x = recoilPitch * 3;
    }

    // Reload progress
    if (reloading) {
      const elapsed = performance.now() - reloadStart;
      const prog = Math.min(1, elapsed / RELOAD_TIME);
      HUD.setReloadProgress(prog);
      if (prog >= 1) {
        const needed = MAX_AMMO - ammo;
        const give   = Math.min(needed, reserve);
        ammo    += give;
        reserve -= give;
        reloading = false;
        HUD.showReloadBar(false);
        HUD.setAmmo(ammo, reserve);
      }
    }

    // Auto-fire
    if ((InputManager.mouse.fireDown || InputManager.joy.fire) && GameState.getState() === 'playing') {
      shoot();
    }
    // Manual reload
    if (InputManager.keys['KeyR']) startReload();
  }

  function addReserve(amt) {
    reserve = Math.min(RESERVE_AMMO + 60, reserve + amt);
    HUD.setAmmo(ammo, reserve);
  }

  return { buildGun, reset, shoot, startReload, applyBob, update, addReserve };
})();

/* ═══════════════════════════════════════════════════════
   ENEMY MANAGER
   Enemies are sentient (self-aware) automatons that
   navigate toward the player via simple steering AI.
═══════════════════════════════════════════════════════ */
const EnemyManager = (() => {
  const enemies = [];
  let idCounter = 0;

  function buildEnemyMesh(type) {
    const group = new THREE.Group();
    const s = type.size;

    // Body
    const bodyG = new THREE.BoxGeometry(s, s*1.5, s*0.7);
    const bodyM = new THREE.MeshLambertMaterial({ color: type.color });
    const body = new THREE.Mesh(bodyG, bodyM);
    body.position.y = s*0.75;
    group.add(body);

    // Head
    const headG = new THREE.SphereGeometry(s*0.38, 8, 8);
    const headM = new THREE.MeshLambertMaterial({ color: type.color });
    const head = new THREE.Mesh(headG, headM);
    head.position.y = s*1.7;
    group.add(head);

    // Eyes
    const eyeG = new THREE.SphereGeometry(s*0.09, 6, 6);
    const eyeM = new THREE.MeshBasicMaterial({ color:0xff0000 });
    [-0.14, 0.14].forEach(ox => {
      const eye = new THREE.Mesh(eyeG, eyeM.clone());
      eye.position.set(ox*s, s*1.72, s*0.36);
      group.add(eye);
    });

    // Arms
    const armG = new THREE.BoxGeometry(s*0.22, s*0.9, s*0.22);
    const armM = new THREE.MeshLambertMaterial({ color: type.color });
    [-1,1].forEach(side => {
      const arm = new THREE.Mesh(armG, armM.clone());
      arm.position.set(side*(s*0.61), s*0.6, 0);
      group.add(arm);
    });

    // Legs
    const legG = new THREE.BoxGeometry(s*0.28, s*0.8, s*0.28);
    [-0.22, 0.22].forEach(lx => {
      const leg = new THREE.Mesh(legG, new THREE.MeshLambertMaterial({ color: type.color }));
      leg.position.set(lx*s, -s*0.05, 0);
      group.add(leg);
    });

    group.traverse(m => { if (m.isMesh) { m.castShadow = true; } });
    return group;
  }

  function spawnEnemy(wave) {
    if (enemies.length >= 20) return;

    const tierProb = Math.random();
    let type;
    if (wave <= 2)      type = ENEMY_TYPES[0];
    else if (wave <= 4) type = tierProb < 0.6 ? ENEMY_TYPES[0] : ENEMY_TYPES[2];
    else if (wave <= 7) type = tierProb < 0.4 ? ENEMY_TYPES[0] : tierProb < 0.7 ? ENEMY_TYPES[2] : ENEMY_TYPES[1];
    else                type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];

    const angle = Math.random() * Math.PI * 2;
    const dist  = 40 + Math.random() * 35;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;

    const mesh = buildEnemyMesh(type);
    mesh.position.set(x, 0, z);
    const id = ++idCounter;
    mesh.userData.enemyId = id;
    mesh.traverse(m => { if (m.isMesh) m.userData.enemyId = id; });
    scene.add(mesh);

    // Health bar (billboard)
    const hbCanvas = document.createElement('canvas');
    hbCanvas.width = 128; hbCanvas.height = 16;
    const hbCtx = hbCanvas.getContext('2d');
    hbCtx.fillStyle = '#ff2233';
    hbCtx.fillRect(0,0,128,16);
    const hbTex = new THREE.CanvasTexture(hbCanvas);
    const hbGeo = new THREE.PlaneGeometry(1.2, 0.14);
    const hbMat = new THREE.MeshBasicMaterial({ map: hbTex, transparent:true, depthWrite:false });
    const hbMesh = new THREE.Mesh(hbGeo, hbMat);
    hbMesh.position.set(0, type.size*2.4, 0);
    mesh.add(hbMesh);

    enemies.push({
      id, mesh, type,
      hp: type.hp, maxHp: type.hp,
      speed: type.speed * (0.85 + Math.random()*0.3),
      attackTimer: 1 + Math.random(),
      dying: false, deathTimer: 0,
      animClock: Math.random()*10,
      hbMesh, hbTex, hbCanvas, hbCtx
    });
  }

  function getAll()      { return enemies; }
  function getById(id)   { return enemies.find(e => e.id === id); }
  function getCount()    { return enemies.length; }

  function damageEnemy(id, dmg, point) {
    const e = getById(id);
    if (!e || e.dying) return;
    e.hp -= dmg;
    AudioManager.sounds.hit();

    // Update health bar canvas
    const pct = Math.max(0, e.hp / e.maxHp);
    const { hbCtx, hbCanvas, hbTex } = e;
    hbCtx.clearRect(0,0,128,16);
    hbCtx.fillStyle = '#330000';
    hbCtx.fillRect(0,0,128,16);
    hbCtx.fillStyle = pct > 0.5 ? '#00ff88' : pct > 0.25 ? '#ffaa00' : '#ff2233';
    hbCtx.fillRect(0,0,128*pct,16);
    hbTex.needsUpdate = true;

    // Blood particles
    if (point) ParticleSystem.spawnBlood(point, 10);

    if (e.hp <= 0 && !e.dying) {
      e.dying = true;
      AudioManager.sounds.enemyDeath();
      GameState.addKill();
      HUD.addKillFeed(e.type.name);
    }
  }

  function update(dt) {
    const playerPos = Player.getPosition();

    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.animClock += dt;

      if (e.dying) {
        // Death animation: fall & fade
        e.deathTimer += dt;
        e.mesh.rotation.z += dt * 4;
        e.mesh.position.y -= dt * 3;
        e.mesh.scale.setScalar(Math.max(0, 1 - e.deathTimer / 0.7));
        if (e.deathTimer > 0.7) {
          scene.remove(e.mesh);
          e.mesh.traverse(m => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose(); } });
          // Chance to drop pickup
          if (Math.random() < 0.22) {
            PickupManager.spawnPickup(e.mesh.position.clone().setY(0.5));
          }
          enemies.splice(i, 1);
        }
        continue;
      }

      // Billboard health bar toward camera
      e.hbMesh.lookAt(camera.position);

      // Steering toward player
      const toPlayer = new THREE.Vector3(
        playerPos.x - e.mesh.position.x,
        0,
        playerPos.z - e.mesh.position.z
      );
      const dist = toPlayer.length();

      if (dist > 1.6) {
        toPlayer.normalize();

        // Slight obstacle avoidance — cast a ray ahead
        const ahead = toPlayer.clone().multiplyScalar(1.5);
        const testPos = e.mesh.position.clone().add(ahead);
        let blocked = false;
        World.getCollidables().forEach(({ box }) => {
          if (box.containsPoint(testPos)) blocked = true;
        });

        if (!blocked) {
          e.mesh.position.addScaledVector(toPlayer, e.speed * dt);
        } else {
          // Try to slide around obstacle
          const slide = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x);
          e.mesh.position.addScaledVector(slide, e.speed * dt);
        }

        // Face player
        e.mesh.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

        // Leg animation
        const legAmpl = Math.sin(e.animClock * 6) * 0.3;
        e.mesh.children.forEach((child,idx) => {
          if (child.geometry && child.geometry.parameters &&
              child.geometry.parameters.height &&
              child.geometry.parameters.height < 1) {
            child.rotation.x = idx % 2 === 0 ? legAmpl : -legAmpl;
          }
        });
      } else {
        // Attack
        e.attackTimer -= dt;
        if (e.attackTimer <= 0) {
          e.attackTimer = 1.5 + Math.random();
          Player.takeDamage(e.type.damage);
          AudioManager.sounds.enemyGroan();
        }
      }

      e.mesh.position.y = Math.max(0, e.mesh.position.y);
    }
  }

  function reset() {
    enemies.forEach(e => {
      scene.remove(e.mesh);
      e.mesh.traverse(m => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose(); } });
    });
    enemies.length = 0;
    idCounter = 0;
  }

  return { spawnEnemy, getAll, getById, getCount, damageEnemy, update, reset };
})();

/* ═══════════════════════════════════════════════════════
   PICKUP MANAGER  (health packs & ammo crates)
═══════════════════════════════════════════════════════ */
const PickupManager = (() => {
  const pickups = [];

  function spawnPickup(pos) {
    const isHealth = Math.random() < 0.5;
    const geo  = isHealth
      ? new THREE.SphereGeometry(0.28, 8, 8)
      : new THREE.BoxGeometry(0.4, 0.3, 0.5);
    const mat  = new THREE.MeshLambertMaterial({
      color: isHealth ? 0x00ff88 : 0xffaa00,
      emissive: isHealth ? 0x004422 : 0x442200
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    scene.add(mesh);

    // Small light
    const pl = new THREE.PointLight(isHealth ? 0x00ff88 : 0xffaa00, 0.6, 4);
    pl.position.copy(pos);
    scene.add(pl);

    pickups.push({ mesh, pl, isHealth, age: 0 });
  }

  function update(dt) {
    const playerPos = Player.getPosition();
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      p.age += dt;
      // Hover animation
      p.mesh.position.y = p.mesh.position.y + Math.sin(p.age * 3) * dt * 0.4;
      p.mesh.rotation.y += dt * 2;

      // Check proximity (2 units radius)
      const dx = playerPos.x - p.mesh.position.x;
      const dz = playerPos.z - p.mesh.position.z;
      if (Math.sqrt(dx*dx + dz*dz) < 1.4) {
        // Collect
        AudioManager.sounds.pickup();
        if (p.isHealth) {
          const heal = 25 + Math.random()*20;
          // Access hp through Player (need a heal method)
          Player.heal(heal);
          HUD.showPickupNotif('+ HEALTH +25');
        } else {
          Player.addAmmo(15);
          HUD.showPickupNotif('+ AMMO +15');
        }
        scene.remove(p.mesh);
        scene.remove(p.pl);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        pickups.splice(i, 1);
      }

      // Despawn after 20s
      if (p.age > 20) {
        scene.remove(p.mesh);
        scene.remove(p.pl);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        pickups.splice(i, 1);
      }
    }
  }

  function reset() {
    pickups.forEach(p => { scene.remove(p.mesh); scene.remove(p.pl); });
    pickups.length = 0;
  }

  return { spawnPickup, update, reset };
})();

/* ═══════════════════════════════════════════════════════
   WAVE SYSTEM  (survival wave escalation)
═══════════════════════════════════════════════════════ */
const WaveSystem = (() => {
  let wave = 1;
  let spawnTimer = 0;
  let spawnInterval = 4;
  let waveKillTarget = 6;
  let waveKills = 0;
  let betweenWaves = false;
  let betweenTimer = 0;
  let lastKills = 0;

  function reset() {
    wave = 1; spawnTimer = 0; spawnInterval = 4;
    waveKillTarget = 6; waveKills = 0;
    betweenWaves = false; betweenTimer = 0; lastKills = 0;
    HUD.setWave(1);
    HUD.setEnemyCount(0);
    HUD.showWaveAnnounce('WAVE 1 — BEGIN!');
    AudioManager.sounds.waveStart();
  }

  function update(dt) {
    if (GameState.getState() !== 'playing') return;

    const totalKills = GameState.getKills();
    const newKills   = totalKills - lastKills;
    waveKills += newKills;
    lastKills  = totalKills;

    if (betweenWaves) {
      betweenTimer -= dt;
      if (betweenTimer <= 0) {
        betweenWaves = false;
        wave++;
        GameState.nextWave();
        waveKillTarget = Math.floor(wave * 5 + wave * 2);
        spawnInterval  = Math.max(1.2, 4 - wave * 0.3);
        waveKills = 0;
        HUD.setWave(wave);
        HUD.showWaveAnnounce(`WAVE ${wave} — BEGIN!`);
        AudioManager.sounds.waveStart();
      }
      return;
    }

    // Spawn logic
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = spawnInterval;
      EnemyManager.spawnEnemy(wave);
    }

    HUD.setEnemyCount(EnemyManager.getCount());

    // Check wave completion
    if (waveKills >= waveKillTarget && EnemyManager.getCount() === 0) {
      betweenWaves = true;
      betweenTimer = 4;
      HUD.showWaveAnnounce(`WAVE ${wave} CLEARED! Next wave in 4s…`);
    }
  }

  return { reset, update };
})();

/* ═══════════════════════════════════════════════════════
   HUD  — DOM update helpers
═══════════════════════════════════════════════════════ */
const HUD = (() => {
  const elHealth    = document.getElementById('health-bar-fill');
  const elHpNum     = document.getElementById('hp-num');
  const elAmmo      = document.getElementById('ammo-current');
  const elReserve   = document.getElementById('ammo-reserve');
  const elWave      = document.getElementById('wave-num');
  const elScore     = document.getElementById('score-num');
  const elEnemy     = document.getElementById('enemy-num');
  const elReloadWrap= document.getElementById('reload-bar-wrap');
  const elReloadFill= document.getElementById('reload-bar-fill');
  const elCH        = document.getElementById('crosshair');
  const elHitMarker = document.getElementById('hit-marker');
  const elKillFeed  = document.getElementById('kill-feed');
  const elPickup    = document.getElementById('pickup-notif');
  const elVignette  = document.getElementById('damage-vignette');
  const elAnnounce  = document.getElementById('wave-announce');
  const elAnnounceT = document.getElementById('wave-announce-text');

  let hitTimeout, chTimeout, pickupTimeout, announceTimeout;

  function update() {
    elScore.textContent = GameState.getKills();
  }

  function setHealth(hp) {
    const pct = (hp / MAX_HP) * 100;
    elHealth.style.width = pct + '%';
    elHealth.style.background = pct > 50
      ? 'linear-gradient(90deg,#00ff88,#88ff44)'
      : pct > 25
        ? 'linear-gradient(90deg,#ffaa00,#ff6600)'
        : 'linear-gradient(90deg,#ff2233,#ff6600)';
    elHpNum.textContent = Math.ceil(hp);
  }

  function setAmmo(a, r) {
    elAmmo.textContent    = a;
    elReserve.textContent = r;
  }

  function setWave(w) { elWave.textContent = w; }
  function setEnemyCount(n) { elEnemy.textContent = n; }

  function showReloadBar(show) {
    if (show) elReloadWrap.classList.remove('hidden');
    else       elReloadWrap.classList.add('hidden');
  }

  function setReloadProgress(p) {
    elReloadFill.style.width = (p*100) + '%';
  }

  function flashCrosshair() {
    elCH.classList.add('crosshair-fire');
    clearTimeout(chTimeout);
    chTimeout = setTimeout(() => elCH.classList.remove('crosshair-fire'), 80);
  }

  function showHitMarker() {
    elHitMarker.classList.remove('hidden');
    clearTimeout(hitTimeout);
    // Force reflow to restart animation
    void elHitMarker.offsetWidth;
    hitTimeout = setTimeout(() => elHitMarker.classList.add('hidden'), 300);
  }

  function addKillFeed(enemyName) {
    update();
    const el = document.createElement('div');
    el.className = 'kill-entry';
    el.textContent = `☠ ${enemyName} eliminated`;
    elKillFeed.appendChild(el);
    setTimeout(() => { if (el.parentNode) elKillFeed.removeChild(el); }, 3000);
    if (elKillFeed.children.length > 5) elKillFeed.removeChild(elKillFeed.firstChild);
  }

  function showPickupNotif(text) {
    clearTimeout(pickupTimeout);
    elPickup.textContent = text;
    elPickup.classList.remove('hidden');
    void elPickup.offsetWidth;
    pickupTimeout = setTimeout(() => elPickup.classList.add('hidden'), 2100);
  }

  function showDamageVignette() {
    elVignette.classList.remove('hidden');
    void elVignette.offsetWidth;
    setTimeout(() => elVignette.classList.add('hidden'), 500);
  }

  function showWaveAnnounce(text) {
    clearTimeout(announceTimeout);
    elAnnounceT.textContent = text;
    elAnnounce.classList.remove('hidden');
    announceTimeout = setTimeout(() => elAnnounce.classList.add('hidden'), 3200);
  }

  return {
    update, setHealth, setAmmo, setWave, setEnemyCount,
    showReloadBar, setReloadProgress, flashCrosshair, showHitMarker,
    addKillFeed, showPickupNotif, showDamageVignette, showWaveAnnounce
  };
})();

/* ═══════════════════════════════════════════════════════
   MOBILE CONTROLS
═══════════════════════════════════════════════════════ */
function buildMobileControls() {
  const isMobile = /Android|iPhone|iPad|iPod|Touch/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.innerWidth < 900);
  if (!isMobile) return;

  // Inject mobile control elements
  const mc = document.createElement('div');
  mc.id = 'mobile-controls';
  document.body.appendChild(mc);

  const joyZone = document.createElement('div');
  joyZone.className = 'joystick-zone';
  joyZone.id = 'joy-zone';
  const knob = document.createElement('div');
  knob.className = 'joystick-knob';
  joyZone.appendChild(knob);
  document.body.appendChild(joyZone);

  const fireBtn = document.createElement('div');
  fireBtn.className = 'fire-btn';
  fireBtn.textContent = '🔥';
  document.body.appendChild(fireBtn);

  const reloadBtn = document.createElement('div');
  reloadBtn.className = 'reload-btn';
  reloadBtn.textContent = 'R';
  document.body.appendChild(reloadBtn);

  // Joystick logic
  const jRect = () => joyZone.getBoundingClientRect();
  joyZone.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    InputManager.joy.active = true;
    InputManager.joy.id = t.identifier;
    const r = jRect();
    InputManager.joy.startX = r.left + r.width/2;
    InputManager.joy.startY = r.top  + r.height/2;
    e.preventDefault();
  }, { passive:false });

  document.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === InputManager.joy.id) {
        const dx = (t.clientX - InputManager.joy.startX) / 50;
        const dy = (t.clientY - InputManager.joy.startY) / 50;
        InputManager.joy.dx = Math.max(-1, Math.min(1, dx));
        InputManager.joy.dy = Math.max(-1, Math.min(1, dy));
        knob.style.transform = `translate(${Math.min(40,Math.abs(dx)*50)*Math.sign(dx)}px, ${Math.min(40,Math.abs(dy)*50)*Math.sign(dy)}px)`;
      }
    }
    e.preventDefault();
  }, { passive:false });

  document.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === InputManager.joy.id) {
        InputManager.joy.active = false;
        InputManager.joy.id = null;
        InputManager.joy.dx = 0;
        InputManager.joy.dy = 0;
        knob.style.transform = '';
      }
    }
  });

  // Look touch on right side
  let lookId = null, lookPrevX = 0, lookPrevY = 0;
  renderer.domElement.addEventListener('touchstart', e => {
    for (const t of e.changedTouches) {
      if (t.clientX > window.innerWidth * 0.35 && lookId === null) {
        lookId = t.identifier;
        lookPrevX = t.clientX;
        lookPrevY = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive:false });

  renderer.domElement.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === lookId) {
        InputManager.joy.lookDx = (t.clientX - lookPrevX);
        InputManager.joy.lookDy = (t.clientY - lookPrevY);
        lookPrevX = t.clientX;
        lookPrevY = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive:false });

  renderer.domElement.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === lookId) { lookId = null; }
    }
  });

  fireBtn.addEventListener('touchstart', () => { InputManager.joy.fire = true; }, { passive:true });
  fireBtn.addEventListener('touchend',   () => { InputManager.joy.fire = false; }, { passive:true });
  reloadBtn.addEventListener('touchstart', () => GunSystem.startReload(), { passive:true });
}

/* ═══════════════════════════════════════════════════════
   MAIN INITIALISATION
═══════════════════════════════════════════════════════ */
function init() {
  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('game-canvas'),
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.2;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c10);
  scene.fog = new THREE.FogExp2(0x0a0c10, 0.018);

  // Camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);
  camera.position.set(0, PLAYER_HEIGHT, 0);
  scene.add(camera);

  // Clock
  clock = new THREE.Clock();

  // Lighting
  const ambient = new THREE.AmbientLight(0x101520, 0.9);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffeecc, 0.6);
  sun.position.set(30, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far  = 200;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -80;
  sun.shadow.camera.right = sun.shadow.camera.top = 80;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  // Stars (skybox particles)
  const starGeo = new THREE.BufferGeometry();
  const starCount = 600;
  const starPos = new Float32Array(starCount * 3);
  for (let i=0; i<starCount*3; i++) starPos[i] = (Math.random()-0.5)*400;
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color:0xffffff, size:0.3, sizeAttenuation:true });
  scene.add(new THREE.Points(starGeo, starMat));

  // Build world & gun
  World.init();
  GunSystem.buildGun();

  // Inputs
  InputManager.init();
  AudioManager.init();

  // Mobile
  buildMobileControls();

  // UI button hooks
  document.getElementById('btn-start').addEventListener('click', () => {
    AudioManager.resume();
    GameState.startGame();
  });
  document.getElementById('btn-restart').addEventListener('click', () => {
    AudioManager.resume();
    GameState.startGame();
  });
  document.getElementById('btn-resume').addEventListener('click', () => {
    GameState.togglePause();
  });
  document.getElementById('btn-menu').addEventListener('click', () => {
    GameState.setState('menu');
    document.getElementById('pause-menu').classList.add('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('start-menu').style.display = 'flex';
    AudioManager.stopBGM();
    EnemyManager.reset();
    ParticleSystem.reset();
    PickupManager.reset();
  });

  // Resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Start render loop
  animate();
}

/* ═══════════════════════════════════════════════════════
   GAME LOOP
═══════════════════════════════════════════════════════ */
function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05); // cap dt to prevent spiral of death

  const state = GameState.getState();

  if (state === 'playing') {
    Player.update(dt);
    GunSystem.update(dt);
    EnemyManager.update(dt);
    PickupManager.update(dt);
    ParticleSystem.update(dt);
    WaveSystem.update(dt);
    HUD.update();
  }

  renderer.render(scene, camera);
}

/* ─── BOOT ─── */
window.addEventListener('DOMContentLoaded', init);
