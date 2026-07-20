import {Composition} from 'remotion';
import {EnterpriseFilm} from './EnterpriseFilm';
import {FILM} from './timeline';

export const Root = () => (
  <Composition
    id="TurboFluxProductFilm"
    component={EnterpriseFilm}
    width={FILM.width}
    height={FILM.height}
    fps={FILM.fps}
    durationInFrames={FILM.durationInFrames}
  />
);
