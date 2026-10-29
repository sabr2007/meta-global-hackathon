// Ayna landing page: static copy in index.html, real run data filled in here, a little motion.
import '../styles/ayna.css';
import './landing.css';
import { loop } from './facts';
import { setupCompare, setupFilm, setupReveal } from './motion';
import { renderCompare, renderEval, renderReceipt, renderRefusals, renderScanFacts } from './proof';
import { renderFilmCaption, renderProblem, renderStations } from './story';

renderFilmCaption();
renderProblem();
renderStations();
const range = renderCompare();
renderReceipt();
renderEval();
renderRefusals();
renderScanFacts();

setupFilm(loop.posterSeconds);
setupCompare(range);
setupReveal();
