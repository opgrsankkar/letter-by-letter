import { render } from 'preact';
import '@fontsource-variable/fraunces/soft.css';
import '@fontsource-variable/bricolage-grotesque';
import './styles.css';
import { App } from './app.tsx';

render(<App />, document.getElementById('app')!);
