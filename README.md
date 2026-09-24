# Safiullah Rahu · Interactive Engineering Portfolio

**Eight interactive simulators across Mechatronics, Medical Imaging, Assistive Robotics and AI. They run in your browser.**

Each app is a working simulator of a real engineering problem. You can tune a servo loop, plan a robot arm's motion, reconstruct CT
and MRI scans, drive a smart wheelchair, control a prosthetic hand with muscle signals, or watch neural networks learn by
back-propagation and by evolution. Every algorithm is implemented from scratch in plain JavaScript, with no frameworks, no
numeric libraries and no build step, and each app's maths lives in a Node-tested core module.

**▶ Live portfolio: [safiullah-rahu.github.io/AI-Applications](https://safiullah-rahu.github.io/AI-Applications/)**
(served by GitHub Pages; see [deployment](#deploy-on-github-pages)). You can also open `index.html` locally.

[![Portfolio hub page](screenshots/portfolio-hub.png)](https://safiullah-rahu.github.io/AI-Applications/)

| Domain | App | Highlights |
|---|---|---|
| ⚙️ Mechatronics | [**MotorLab**: PID servo tuning studio](mechatronics/pid-motor-lab/) | RK4 DC-motor physics · anti-windup PID · relay auto-tuning · Bode margins · pole map |
| ⚙️ Mechatronics | [**ArmStudio**: robot arm kinematics & C-space planner](mechatronics/robot-arm-studio/) | analytic and DLS inverse kinematics · manipulability · configuration space · A* motion planning |
| 🩻 Medical Imaging | [**TomoLab**: CT reconstruction lab](medical-imaging/ct-reconstruction-lab/) | analytic Radon transform · dose noise and artefacts · FBP · OS-SART · TV regularisation |
| 🧠 Medical Imaging | [**k-Space Explorer**: MRI physics & reconstruction](medical-imaging/mri-kspace-explorer/) | pulse-sequence contrast · k-space sampling · artefacts · compressed sensing (FISTA) · POCS |
| ♿ Assistive Robotics | [**NaviChair**: smart wheelchair navigator](assistive-robotics/smart-wheelchair-navigator/) | LIDAR · distance-transform costmap · A* · dynamic window · shared control · mapping |
| 🦾 Assistive Robotics | [**MyoHand**: EMG prosthetic hand controller](assistive-robotics/emg-prosthetic-hand/) | 8-channel sEMG · Hudgins features · LDA / k-NN / MLP · proportional hand control |
| 🤖 AI | [**NeuroPlayground**: neural networks from scratch](ai/neural-network-playground/) | back-propagation · Adam · activation maps · decision boundaries · gradient flow |
| 🤖 AI | [**EvoDrive**: neuroevolution self-driving cars](ai/neuroevolution-cars/) | genetic algorithm · ray sensors · grip-limited physics · procedural tracks · race the AI |

---

## ⚙️ Mechatronics

### MotorLab: PID Servo Tuning Studio
[![MotorLab](screenshots/pid-motor-lab.png)](mechatronics/pid-motor-lab/)

This is a physics-based DC servo (electrical and mechanical dynamics, Coulomb friction, saturation, encoder quantisation) under
digital PID control. Tune position or velocity loops and capture and pin step responses with rise, overshoot, settling, error and IAE
metrics. The loop is also analysed in the frequency domain (Bode margins, closed-loop poles), and relay (Åström–Hägglund) or
model-based (FOPDT + SIMC) auto-tuners are included. **[Open app](mechatronics/pid-motor-lab/index.html) · [Details](mechatronics/pid-motor-lab/README.md)**

### ArmStudio: Robot Arm Kinematics & C-Space Planner
[![ArmStudio](screenshots/robot-arm-studio.png)](mechatronics/robot-arm-studio/)

This is a 2R/3R planar manipulator. Solve closed-form and damped-least-squares inverse kinematics, and see Yoshikawa manipulability
ellipses and gravity holding torques. Configuration-space obstacles are computed from exact capsule collision checks. Motion is
planned with A* on a 180² grid or 72³ lattice, then shortcut-smoothed and given quintic time scaling. There is also a draw
mode that turns the arm into a plotter. **[Open app](mechatronics/robot-arm-studio/index.html) · [Details](mechatronics/robot-arm-studio/README.md)**

## 🩻 Medical Imaging

### TomoLab: CT Reconstruction Lab
[![TomoLab](screenshots/ct-reconstruction-lab.png)](medical-imaging/ct-reconstruction-lab/)

This is the full chain of a parallel-beam CT scanner, from an analytic phantom and its Radon transform, through Poisson dose noise and metal, ring and
motion artefacts, to filtered back-projection (with a choice of windowed ramp filters), OS-SART or SART-TV. Results are compared with signed error
maps, RMSE in HU, PSNR and SSIM. **[Open app](medical-imaging/ct-reconstruction-lab/index.html) · [Details](medical-imaging/ct-reconstruction-lab/README.md)**

### k-Space Explorer: MRI Physics & Reconstruction
[![k-Space Explorer](screenshots/mri-kspace-explorer.png)](medical-imaging/mri-kspace-explorer/)

It uses a procedural brain with a tumour and oedema. Set spin-echo, inversion-recovery and gradient-echo contrast (T1w, T2w, PD, FLAIR, STIR), and
see and paint k-space, with undersampling patterns, RF-spike and motion artefacts. Reconstruct with zero-filling, compressed sensing
(FISTA + Haar wavelets) or POCS partial Fourier. **[Open app](medical-imaging/mri-kspace-explorer/index.html) · [Details](medical-imaging/mri-kspace-explorer/README.md)**

## ♿ Assistive Robotics

### NaviChair: Smart Wheelchair Shared-Control Navigator
[![NaviChair](screenshots/smart-wheelchair-navigator.png)](assistive-robotics/smart-wheelchair-navigator/)

This is a powered wheelchair with a 360° LIDAR in an apartment with moving people. It plans with an exact distance-transform costmap and A*,
and follows the route with the Dynamic Window Approach, pure pursuit and docking. It has manual, shared (with tremor filtering) and
autonomous modes, takes voice-style commands ("take me to the kitchen") and builds a log-odds map as it drives.
**[Open app](assistive-robotics/smart-wheelchair-navigator/index.html) · [Details](assistive-robotics/smart-wheelchair-navigator/README.md)**

### MyoHand: EMG Prosthetic Hand Controller
[![MyoHand](screenshots/emg-prosthetic-hand.png)](assistive-robotics/emg-prosthetic-hand/)

This is the myoelectric pattern-recognition pipeline used in modern prostheses: 8-channel surface EMG synthesis, filtering, Hudgins
features, and LDA, k-NN or MLP classifiers evaluated on held-out repetitions. Decisions are smoothed by majority vote with rejection, and they drive an animated
robotic hand. Electrode shift, fatigue and interference show why recalibration matters.
**[Open app](assistive-robotics/emg-prosthetic-hand/index.html) · [Details](assistive-robotics/emg-prosthetic-hand/README.md)**

## 🤖 Artificial Intelligence

### NeuroPlayground: Neural Networks from Scratch
[![NeuroPlayground](screenshots/neural-network-playground.png)](ai/neural-network-playground/)

Train a multilayer perceptron in your browser, with gradients checked against finite differences. It shows every neuron's activation map,
the decision boundary, loss curves and per-layer gradient flow, and includes experiments on vanishing gradients, overfitting and
feature engineering. **[Open app](ai/neural-network-playground/index.html) · [Details](ai/neural-network-playground/README.md)**

### EvoDrive: Neuroevolution Self-Driving Cars
[![EvoDrive](screenshots/neuroevolution-cars.png)](ai/neuroevolution-cars/)

A population of neural-network drivers learns to race on procedurally generated circuits by selection, crossover and mutation. There is no
gradient and no training data. The cars have ray-cast sensors, grip-limited physics that forces them to learn braking, and a live
brain view. You can test generalisation on new tracks, then race the champion yourself.
**[Open app](ai/neuroevolution-cars/index.html) · [Details](ai/neuroevolution-cars/README.md)**

---

## Engineering notes

- **Written from scratch.** FFTs, Radon transforms, reconstruction algorithms, distance transforms, planners, classifiers,
  back-propagation and the genetic algorithm are all hand-written. The source is meant to be read.
- **Separated cores.** Each app keeps its maths in a DOM-free `*-core.js` module (loadable in Node or the browser) and its UI
  in `app.js`. The design system and plotting live in [`shared/`](shared/).
- **Tested.** [`tests/run-tests.js`](tests/run-tests.js) checks the cores against analytic results, brute-force references and finite differences.
  It runs 34 tests covering all 8 apps in about 5 s with no dependencies.
- **Static and portable.** The apps are plain HTML, CSS and JS with self-hosted fonts. They work from `file://`, any static server or GitHub Pages,
  offline, with no API keys.

## Run locally

```bash
git clone https://github.com/Safiullah-Rahu/AI-Applications.git
cd AI-Applications
# either open index.html directly in a browser, or serve the folder:
python3 -m http.server 8000     # then visit http://localhost:8000
```

Run the tests (Node.js 18 or later):

```bash
node tests/run-tests.js          # or: npm test
```

Regenerate the screenshots with headless Chromium:

```bash
npm i -D playwright && npx playwright install chromium
node tools/screenshots.js
```

## Deploy on GitHub Pages

1. **Settings → Pages → Build and deployment → Deploy from a branch.**
2. Choose branch `main` and folder `/ (root)`, then save.
3. After a minute the portfolio is live at `https://safiullah-rahu.github.io/AI-Applications/`.

The empty `.nojekyll` file tells Pages to serve the files as they are.

## Repository layout

```
index.html                     portfolio hub page
shared/                        design system (lab.css), fonts, LabMath numerics, Lab UI and plotting
mechatronics/
  pid-motor-lab/               MotorLab
  robot-arm-studio/            ArmStudio
medical-imaging/
  ct-reconstruction-lab/       TomoLab
  mri-kspace-explorer/         k-Space Explorer
assistive-robotics/
  smart-wheelchair-navigator/  NaviChair
  emg-prosthetic-hand/         MyoHand
ai/
  neural-network-playground/   NeuroPlayground
  neuroevolution-cars/         EvoDrive
tests/run-tests.js             core-module test suite
tools/screenshots.js           screenshot generator (Playwright)
screenshots/                   README and hub images
GPT_app.py                     original GPT-3 Streamlit app (below)
```

---

## GPT-3 Text Generator Streamlit App

*This is the repository's original project, kept for reference.*

This script uses the Python library Streamlit to create a user interface for a text generation application that uses the OpenAI GPT-3 language model. It imports the OpenAI library and sets the API key to access the GPT-3 model. A function generates text with the GPT-3 model from a user-entered prompt. The Streamlit UI includes a title, a text input field for the prompt, and a button that triggers the text generation. When the button is pressed, the generated text is displayed in the UI.

<img src="assets/GPT-3_App.PNG">

### Getting Started
1. Install the required libraries by running `pip install streamlit openai` in your command prompt/terminal.
2. Clone or download this repository to your local machine.
3. In the `GPT_app.py` file, replace `api_key` with your own OpenAI API key.
4. Run the script with `streamlit run GPT_app.py` in your command prompt/terminal while in the project directory.
5. A browser window opens. Enter a prompt and click the "Generate Text" button.

### Understanding the Code
The script starts by importing the necessary libraries, `streamlit` and `openai`. It then sets the OpenAI API key and creates a function `generate_text()` which takes a prompt as input and returns text generated by the GPT-3 model.

The `generate_text()` function uses the `openai.Completion.create()` method to generate text from the given prompt. Parameters such as engine, max_tokens, n, stop and temperature can be adjusted as needed.

Finally, the script creates a simple user interface with Streamlit's `st.title()`, `st.text_input()` and `st.button()` functions to take the prompt and display the generated text.

### Note
The script is set to use the "text-davinci-002" engine, which OpenAI has since retired. Newer models are available through the current OpenAI API.
