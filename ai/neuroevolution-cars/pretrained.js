/* EvoDrive — a pre-trained driver (8–8–2 network, 90 weights).
   Evolved offline in Node.js for 300 generations with domain randomisation (every generation scored on 4 random tracks), champion picked on 30 validation tracks; completes 59 of 60 unseen random tracks.
   Load it from the Champion panel, race against it, or seed a new population with it.
   Regenerate with: node ai/neuroevolution-cars/tools/train-driver.js */
window.EVO_PRETRAINED = {
  hidden: 8,
  genome: [
    -1.9891, 1.2199, 1.6828, 0.5725, -0.3494, 0.4259, -1.5042, -1.8446, 0.1871, -2.206,
    -3.1955, 0.3534, 3.6008, 0.9949, 0.6492, 1.9235, 2.2739, 1.4226, 1.2926, 2.1181,
    1.5103, -3.1954, -1.0986, -0.6909, 1.8569, 3.1487, -0.5262, -4.5095, -1.4336, -0.0662,
    0.7009, -4.5256, -3.0135, 1.6666, -1.4476, -2.1931, 4.0762, -0.1084, -1.9159, -0.1089,
    2.3437, 0.8907, 2.0783, -1.5561, 2.5336, -1.3637, -0.4941, 2.4146, 0.6853, 1.9958,
    -0.7667, -0.8135, -0.5191, -1.327, 0.2509, 4.3593, 0.858, -0.2458, -3.4157, -0.0736,
    -0.8972, -2.8562, -2.3009, 1.3486, 1.7117, 0.3271, 1.3332, 1.5248, 2.3257, -2.5723,
    0.3715, -0.6559, 0.7984, -4.523, -1.125, -1.9124, -3.0455, 1.7683, 1.8208, -1.253,
    1.4221, -3.2865, 1.881, 7.2236, -0.3379, -1.7335, -1.0115, -1.3522, -0.9364, 0.2021,
  ],
};
