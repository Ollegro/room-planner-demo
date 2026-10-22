/**
 * Точка входа прототипа: связывает интерфейс, чистую логику и 3D-сцену.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { parsePlan } from './plan.js';
import { validatePlan } from './rules.js';
import { buildScene } from './build.js';

const PLANS = [
  { file: 'plans/demo_1room.json', title: 'Демо 1: студия 4200x3600, расстановка корректна' },
  { file: 'plans/demo_2rooms.json', title: 'Демо 2: 6000x4000 с перегородкой, есть нарушения' },
];

const ui = {
  select: document.getElementById('plan-select'),
  load: document.getElementById('load-plan'),
  json: document.getElementById('plan-json'),
  build: document.getElementById('build'),
  exportBtn: document.getElementById('export'),
  status: document.getElementById('status'),
  metrics: document.getElementById('metrics'),
  violations: document.getElementById('violations'),
  toggleCeiling: document.getElementById('toggle-ceiling'),
  toggleMarkers: document.getElementById('toggle-markers'),
  toggleWireframe: document.getElementById('toggle-wireframe'),
  viewport: document.getElementById('viewport'),
  canvas: document.getElementById('canvas'),
};

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141c26);

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
camera.position.set(6, 5.5, 7);

const controls = new OrbitControls(camera, ui.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 1;
controls.maxDistance = 60;

scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3a4a, 1.05));
scene.add(new THREE.AmbientLight(0xffffff, 0.25));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(7, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
scene.add(sun);

const grid = new THREE.GridHelper(60, 120, 0x44586f, 0x22303f);
grid.position.y = -0.001;
scene.add(grid);
scene.add(new THREE.AxesHelper(1.5));

const state = { plan: null, report: null, built: null, wireframe: false, topView: false };


function resize() {
  const width = ui.viewport.clientWidth;
  const height = ui.viewport.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(ui.viewport);

function disposeObject(object) {
  object.traverse((child) => {
    if (child.isMesh && child.geometry) child.geometry.dispose();
  });
  scene.remove(object);
}

function setStatus(kind, text) {
  ui.status.className = `status ${kind}`;
  ui.status.textContent = text;
}

function renderMetrics(metrics) {
  const rows = [
    ['Площадь пола', `${metrics.floorArea} м²`],
    ['Периметр', `${metrics.perimeter} м`],
    ['Высота потолка', `${metrics.ceilingHeight} м`],
    ['Объём', `${metrics.volume} м³`],
    ['Стены (нетто)', `${metrics.wallAreaNet} м²`],
    ['Проёмы', `${metrics.openingsArea} м² (${metrics.openingCount})`],
    ['Мебель', `${metrics.furnitureCount} шт, ${metrics.furnitureArea} м²`],
    ['Занято пола', `${Math.round(metrics.occupancy * 100)} %`],
  ];
  ui.metrics.innerHTML = rows
    .map(([label, value]) => `<div><span>${label}</span><span>${value}</span></div>`)
    .join('');
}

function renderViolations(report) {
  ui.violations.innerHTML = '';
  if (report.violations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'violation empty';
    empty.textContent = 'Нарушений не найдено — расстановка проходит все проверки.';
    ui.violations.appendChild(empty);
    return;
  }
  for (const item of report.violations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `violation ${item.severity}`;
    button.innerHTML = `${item.message}<code>${item.code}</code>`;
    button.addEventListener('click', () => focusOn(item.targetId));
    ui.violations.appendChild(button);
  }
}

function applyWireframe() {
  if (!state.built) return;
  state.built.root.traverse((child) => {
    if (child.isMesh && child.material && 'wireframe' in child.material) {
      child.material.wireframe = state.wireframe;
    }
  });
}

/** Разбор JSON -> валидация -> пересборка сцены и панелей интерфейса. */
function rebuild(json, { fitCamera = true } = {}) {
  let plan;
  try {
    plan = parsePlan(json);
  } catch (error) {
    setStatus('error', `План отклонён: ${error.message}`);
    return false;
  }

  const report = validatePlan(plan);
  if (state.built) disposeObject(state.built.root);
  state.built = buildScene(plan, report, { ceiling: ui.toggleCeiling.checked });
  scene.add(state.built.root);
  state.built.markers.visible = ui.toggleMarkers.checked;
  applyWireframe();

  state.plan = plan;
  state.report = report;

  setStatus(
    report.stats.status,
    report.stats.status === 'ok'
      ? `Проверок: ${report.stats.checksRun}. Нарушений нет.`
      : `Проверок: ${report.stats.checksRun}. Ошибок: ${report.stats.errors}, предупреждений: ${report.stats.warnings}.`,
  );
  renderMetrics(plan.metrics);
  renderViolations(report);

  if (fitCamera) fitView();
  return true;
}

/** Показать весь план целиком. */
function fitView() {
  if (!state.built) return;
  const box = new THREE.Box3().setFromObject(state.built.root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, size.y) * 0.8 + 1;
  const direction = state.topView ? new THREE.Vector3(0.001, 1, 0.001) : new THREE.Vector3(1, 0.9, 1).normalize();
  camera.position.copy(center).addScaledVector(direction.normalize(), radius * 1.6);
  controls.target.copy(center);
  controls.update();
}

/** Приблизить камеру к объекту-нарушителю. */
function focusOn(id) {
  const object = state.built && state.built.byId.get(id);
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.z, size.y) * 2.2 + 1.2;
  const direction = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (direction.lengthSq() < 1e-6) direction.set(1, 0.85, 1);
  direction.normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  controls.target.copy(center);
  controls.update();
}

/** Экспорт текущей сцены в .glb — дальше её можно открыть в Blender/Unity. */
function exportGlb() {
  if (!state.built) return;
  const exporter = new GLTFExporter();
  exporter.parse(
    state.built.root,
    (result) => {
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${String(state.plan.name || 'plan').replace(/[^\wа-яА-Я-]+/g, '_')}.glb`;
      link.click();
      URL.revokeObjectURL(url);
      setStatus(state.report.stats.status, 'Сцена экспортирована в .glb (открывается в Blender, Unity, Unreal).');
    },
    (error) => setStatus('error', `Ошибка экспорта: ${error.message}`),
    { binary: true },
  );
}

async function loadSelected() {
  try {
    const response = await fetch(ui.select.value);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    ui.json.value = JSON.stringify(json, null, 2);
    rebuild(json);
  } catch (error) {
    setStatus(
      'error',
      `Не удалось загрузить пример (${error.message}). Откройте страницу через локальный сервер: npm start.`,
    );
  }
}

function applyFromTextarea() {
  try {
    rebuild(JSON.parse(ui.json.value));
  } catch (error) {
    setStatus('error', `Ошибка разбора JSON: ${error.message}`);
  }
}

function readDroppedFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    ui.json.value = String(reader.result);
    applyFromTextarea();
  };
  reader.readAsText(file);
}

function bindUi() {
  ui.load.addEventListener('click', loadSelected);
  ui.build.addEventListener('click', applyFromTextarea);
  ui.exportBtn.addEventListener('click', exportGlb);

  ui.toggleCeiling.addEventListener('change', () => {
    try {
      rebuild(JSON.parse(ui.json.value), { fitCamera: false });
    } catch (error) {
      setStatus('error', `Ошибка разбора JSON: ${error.message}`);
    }
  });
  ui.toggleMarkers.addEventListener('change', () => {
    if (state.built) state.built.markers.visible = ui.toggleMarkers.checked;
  });
  ui.toggleWireframe.addEventListener('change', () => {
    state.wireframe = ui.toggleWireframe.checked;
    applyWireframe();
  });

  for (const event of ['dragenter', 'dragover']) {
    ui.viewport.addEventListener(event, (event_) => {
      event_.preventDefault();
      ui.viewport.classList.add('dragging');
    });
  }
  for (const event of ['dragleave', 'drop']) {
    ui.viewport.addEventListener(event, (event_) => {
      event_.preventDefault();
      ui.viewport.classList.remove('dragging');
    });
  }
  ui.viewport.addEventListener('drop', (event_) => {
    const file = event_.dataTransfer && event_.dataTransfer.files[0];
    if (file) readDroppedFile(file);
  });
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

ui.select.innerHTML = PLANS.map((p) => `<option value="${p.file}">${p.title}</option>`).join('');

// План и ракурс можно выбрать ссылкой: ?plan=plans/demo_2rooms.json&view=top
const urlParams = new URLSearchParams(window.location.search);
const requestedPlan = urlParams.get('plan');
if (requestedPlan && PLANS.some((p) => p.file === requestedPlan)) {
  ui.select.value = requestedPlan;
}
state.topView = urlParams.get('view') === 'top';

bindUi();
resize();
animate();
loadSelected();

