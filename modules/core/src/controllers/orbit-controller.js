import {clamp, Vector2} from 'math.gl';
import Controller from './controller';
import ViewState from './view-state';
import LinearInterpolator from '../transitions/linear-interpolator';
import {TRANSITION_EVENTS} from './transition-manager';
import {mod} from '../utils/math-utils';

const DEFAULT_STATE = {
  orbitAxis: 'Z',
  rotationX: 0,
  rotationOrbit: 0,
  zoom: 0,
  target: [0, 0, 0],
  minRotationX: -90,
  maxRotationX: 90,
  minZoom: -Infinity,
  maxZoom: Infinity
};

const LINEAR_TRANSITION_PROPS = {
  transitionDuration: 300,
  transitionEasing: t => t,
  transitionInterpolator: new LinearInterpolator(['target', 'zoom', 'rotationX', 'rotationOrbit']),
  transitionInterruption: TRANSITION_EVENTS.BREAK
};

/* Helpers */

const zoom2Scale = zoom => Math.pow(2, zoom);

export class OrbitState extends ViewState {
  constructor({
    makeViewport,

    /* Viewport arguments */
    width, // Width of viewport
    height, // Height of viewport
    orbitAxis = DEFAULT_STATE.orbitAxis,
    rotationX = DEFAULT_STATE.rotationX, // Rotation around x axis
    rotationOrbit = DEFAULT_STATE.rotationOrbit, // Rotation around orbit axis
    target = DEFAULT_STATE.target,
    zoom = DEFAULT_STATE.zoom,

    /* Viewport constraints */
    minRotationX = DEFAULT_STATE.minRotationX,
    maxRotationX = DEFAULT_STATE.maxRotationX,
    minZoom = DEFAULT_STATE.minZoom,
    maxZoom = DEFAULT_STATE.maxZoom,

    /** Interaction states, required to calculate change during transform */
    // Model state when the pan operation first started
    startPanPosition,
    startTarget,
    // Model state when the rotate operation first started
    startRotatePos,
    startRotationX,
    startRotationOrbit,
    // Model state when the zoom operation first started
    startZoomPosition,
    startZoom
  }) {
    super({
      width,
      height,
      orbitAxis,
      rotationX,
      rotationOrbit,
      target,
      zoom,
      minRotationX,
      maxRotationX,
      minZoom,
      maxZoom
    });

    this._state = {
      startPanPosition,
      startTarget,
      startRotatePos,
      startRotationX,
      startRotationOrbit,
      startZoomPosition,
      startZoom
    };

    this.makeViewport = makeViewport;
  }

  /**
   * Start panning
   * @param {[Number, Number]} pos - position on screen where the pointer grabs
   */
  panStart({pos}) {
    const {target} = this._viewportProps;

    return this._getUpdatedState({
      startPanPosition: pos,
      startTarget: target
    });
  }

  /**
   * Pan
   * @param {[Number, Number]} pos - position on screen where the pointer is
   */
  pan({pos, startPos}) {
    const {startPanPosition, startTarget} = this._state;
    const delta = new Vector2(pos).subtract(startPanPosition);

    return this._getUpdatedState({
      target: this._calculateNewTarget({startTarget, pixelOffset: delta})
    });
  }

  /**
   * End panning
   * Must call if `panStart()` was called
   */
  panEnd() {
    return this._getUpdatedState({
      startPanPosition: null,
      startTarget: null
    });
  }

  /**
   * Start rotating
   * @param {[Number, Number]} pos - position on screen where the pointer grabs
   */
  rotateStart({pos}) {
    return this._getUpdatedState({
      startRotatePos: pos,
      startRotationX: this._viewportProps.rotationX,
      startRotationOrbit: this._viewportProps.rotationOrbit
    });
  }

  /**
   * Rotate
   * @param {[Number, Number]} pos - position on screen where the pointer is
   */
  rotate({pos, deltaAngleX = 0, deltaAngleY = 0}) {
    const {startRotatePos, startRotationX, startRotationOrbit} = this._state;
    const {width, height} = this._viewportProps;

    if (
      !startRotatePos ||
      !Number.isFinite(startRotationX) ||
      !Number.isFinite(startRotationOrbit)
    ) {
      return this;
    }

    let newRotation;
    if (pos) {
      let deltaScaleX = (pos[0] - startRotatePos[0]) / width;
      const deltaScaleY = (pos[1] - startRotatePos[1]) / height;

      if (startRotationX < -90 || startRotationX > 90) {
        // When looking at the "back" side of the scene, invert horizontal drag
        // so that the camera movement follows user input
        deltaScaleX *= -1;
      }
      newRotation = {
        rotationX: startRotationX + deltaScaleY * 180,
        rotationOrbit: startRotationOrbit + deltaScaleX * 180
      };
    } else {
      newRotation = {
        rotationX: startRotationX + deltaAngleY,
        rotationOrbit: startRotationOrbit + deltaAngleX
      };
    }

    return this._getUpdatedState(newRotation);
  }

  /**
   * End rotating
   * Must call if `rotateStart()` was called
   */
  rotateEnd() {
    return this._getUpdatedState({
      startRotationX: null,
      startRotationOrbit: null
    });
  }

  // shortest path between two view states
  shortestPathFrom(viewState) {
    const fromProps = viewState.getViewportProps();
    const props = {...this._viewportProps};
    const {rotationOrbit} = props;

    if (Math.abs(rotationOrbit - fromProps.rotationOrbit) > 180) {
      props.rotationOrbit = rotationOrbit < 0 ? rotationOrbit + 360 : rotationOrbit - 360;
    }

    return props;
  }

  /**
   * Start zooming
   * @param {[Number, Number]} pos - position on screen where the pointer grabs
   */
  zoomStart({pos}) {
    return this._getUpdatedState({
      startZoomPosition: pos,
      startTarget: this._viewportProps.target,
      startZoom: this._viewportProps.zoom
    });
  }

  /**
   * Zoom
   * @param {[Number, Number]} pos - position on screen where the current target is
   * @param {[Number, Number]} startPos - the target position at
   *   the start of the operation. Must be supplied of `zoomStart()` was not called
   * @param {Number} scale - a number between [0, 1] specifying the accumulated
   *   relative scale.
   */
  zoom({pos, startPos, scale}) {
    const {zoom, width, height, target} = this._viewportProps;
    let {startZoom, startZoomPosition, startTarget} = this._state;
    if (!Number.isFinite(startZoom)) {
      // We have two modes of zoom:
      // scroll zoom that are discrete events (transform from the current zoom level),
      // and pinch zoom that are continuous events (transform from the zoom level when
      // pinch started).
      // If startZoom state is defined, then use the startZoom state;
      // otherwise assume discrete zooming
      startZoom = zoom;
      startTarget = target;
      startZoomPosition = startPos || pos;
    }

    const newZoom = this._calculateNewZoom({scale, startZoom});
    const startScale = zoom2Scale(startZoom);
    const newScale = zoom2Scale(newZoom);

    const dX = (width / 2 - startZoomPosition[0]) * (newScale / startScale - 1);
    const dY = (height / 2 - startZoomPosition[1]) * (newScale / startScale - 1);

    return this._getUpdatedState({
      zoom: newZoom,
      target: this._calculateNewTarget({startTarget, zoom: newZoom, pixelOffset: [dX, dY]})
    });
  }

  /**
   * End zooming
   * Must call if `zoomStart()` was called
   */
  zoomEnd() {
    return this._getUpdatedState({
      startZoomPosition: null,
      startTarget: null,
      startZoom: null
    });
  }

  zoomIn(speed = 2) {
    return this._getUpdatedState({
      zoom: this._calculateNewZoom({scale: speed})
    });
  }

  zoomOut(speed = 2) {
    return this._getUpdatedState({
      zoom: this._calculateNewZoom({scale: 1 / speed})
    });
  }

  moveLeft(speed = 50) {
    const pixelOffset = [-speed, 0];
    return this._getUpdatedState({
      target: this._calculateNewTarget({pixelOffset})
    });
  }

  moveRight(speed = 50) {
    const pixelOffset = [speed, 0];
    return this._getUpdatedState({
      target: this._calculateNewTarget({pixelOffset})
    });
  }

  moveUp(speed = 50) {
    const pixelOffset = [0, -speed];
    return this._getUpdatedState({
      target: this._calculateNewTarget({pixelOffset})
    });
  }

  moveDown(speed = 50) {
    const pixelOffset = [0, speed];
    return this._getUpdatedState({
      target: this._calculateNewTarget({pixelOffset})
    });
  }

  rotateLeft(speed = 15) {
    return this._getUpdatedState({
      rotationOrbit: this._viewportProps.rotationOrbit - speed
    });
  }

  rotateRight(speed = 15) {
    return this._getUpdatedState({
      rotationOrbit: this._viewportProps.rotationOrbit + speed
    });
  }

  rotateUp(speed = 10) {
    return this._getUpdatedState({
      rotationX: this._viewportProps.rotationX - speed
    });
  }

  rotateDown(speed = 10) {
    return this._getUpdatedState({
      rotationX: this._viewportProps.rotationX + speed
    });
  }

  /* Private methods */

  // Calculates new zoom
  _calculateNewZoom({scale, startZoom}) {
    const {maxZoom, minZoom} = this._viewportProps;
    if (!Number.isFinite(startZoom)) {
      startZoom = this._viewportProps.zoom;
    }
    const zoom = startZoom + Math.log2(scale);
    return clamp(zoom, minZoom, maxZoom);
  }

  _calculateNewTarget({startTarget, zoom, pixelOffset}) {
    const viewportProps = {...this._viewportProps};
    if (Number.isFinite(zoom)) {
      viewportProps.zoom = zoom;
    }
    if (startTarget) {
      viewportProps.target = startTarget;
    }
    const viewport = this.makeViewport(viewportProps);
    const center = viewport.project(viewportProps.target);
    return viewport.unproject([center[0] - pixelOffset[0], center[1] - pixelOffset[1], center[2]]);
  }

  _getUpdatedState(newProps) {
    // Update _viewportProps
    return new OrbitState({...this._viewportProps, ...this._state, ...newProps});
  }

  // Apply any constraints (mathematical or defined by _viewportProps) to map state
  _applyConstraints(props) {
    // Ensure zoom is within specified range
    const {maxZoom, minZoom, zoom, maxRotationX, minRotationX, rotationOrbit} = props;

    props.zoom = clamp(zoom, minZoom, maxZoom);
    props.rotationX = clamp(props.rotationX, minRotationX, maxRotationX);
    if (rotationOrbit < -180 || rotationOrbit > 180) {
      props.rotationOrbit = mod(rotationOrbit + 180, 360) - 180;
    }

    return props;
  }
}

export default class OrbitController extends Controller {
  constructor(props) {
    super(OrbitState, props);
  }

  _getTransitionProps() {
    // Enables Transitions on double-tap and key-down events.
    return LINEAR_TRANSITION_PROPS;
  }
}
