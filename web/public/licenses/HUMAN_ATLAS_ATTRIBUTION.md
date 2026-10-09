# Human Atlas anatomy data attribution

This application incorporates the browser-ready anatomy geometry, metadata
packaging, and rendering techniques from
[ashemag/human-atlas](https://github.com/ashemag/human-atlas). The Human Atlas
application code is released under the MIT License; its complete license notice
is distributed beside this file as `HUMAN_ATLAS_LICENSE.txt`.

BodyParts3D, © The Database Center for Life Science, is licensed under the
Creative Commons Attribution 4.0 International License (CC BY 4.0).

- License: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html
- Dataset: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
- License terms: https://creativecommons.org/licenses/by/4.0/
- Source geometry: `isa_BP3D_4.0_obj_99.zip`, BodyParts3D 4.0
- Publication: Mitsuhashi et al. (2009), BodyParts3D: 3D structure database
  for anatomical concepts. https://doi.org/10.1093/nar/gkn613

Adaptations inherited from Human Atlas: axes and units converted from
millimeters/Z-up to meters/Y-up; geometry translated onto the stage and
simplified with a 0.2% relative error limit per structure; normals quantized to
signed 16-bit; geometry packed into browser-ready binary chunks; display-system
groupings and colors curated for interactive exploration.

HealthPocket adds an independent Chinese label to every BodyParts3D mesh, maps
BodyParts3D/FMA concepts to health-report domains, and colors mapped structures
using the selected report year's status. Chinese terminology was generated and
reviewed against the bilingual BodyParts3D index in
[jixiangying/anatomy](https://github.com/jixiangying/anatomy), with corrections
for the more specific English mesh names used by Human Atlas.

BodyParts3D is an adult male reference anatomy. HealthPocket's female mode
supplements the source atlas with simple navigation markers for female-specific
organs; these markers are not BodyParts3D anatomy data.

The atlas is a navigation aid for user-owned health reports, not a diagnostic,
surgical, or anatomical teaching tool.
