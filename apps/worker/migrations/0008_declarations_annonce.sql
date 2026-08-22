-- Les déclarations qu'exigent les places de marché à la création d'une annonce.
--
-- Elles étaient jusqu'ici codées en dur dans les adaptateurs — « neuf » chez
-- eBay, « fait main par moi, à la commande » chez Etsy — donc fausses pour
-- toute revente, et invisibles de bout en bout. Les stocker au niveau du
-- produit maître permet de les déclarer une fois et de les diffuser partout.
--
-- Toutes nullables : un produit importé d'une plateforme n'en a pas, et leur
-- absence bloque la publication plutôt que d'inventer une valeur.

ALTER TABLE product ADD COLUMN condition TEXT;
ALTER TABLE product ADD COLUMN who_made TEXT;
ALTER TABLE product ADD COLUMN when_made TEXT;
